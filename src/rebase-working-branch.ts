import * as fs from "node:fs";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  ensureClean,
  git,
  gitOk,
  localBranchExists,
  remoteBranchExists,
  rev,
} from "./utils/git";
import { run } from "./utils/proc";

const argv = yargs(hideBin(process.argv))
  .usage("$0 [options]")
  .option("baseRef", {
    type: "string",
    default: process.env.BASE_REF ?? "origin/develop-upstream",
    describe: "Base reference used to reset working branch",
  })
  .option("baseTag", {
    type: "string",
    default: process.env.BASE_TAG,
    describe:
      "Optional tag name to pin baseRef (must exist on develop-upstream)",
  })
  .option("workingBranch", {
    type: "string",
    default: process.env.WORKING_BRANCH ?? "develop-working",
    describe: "Ephemeral integration prep branch name",
  })
  .option("toolRepo", {
    type: "string",
    default:
      process.env.TOOL_REPO ??
      "https://github.com/tiramiss-community/tiramiss-repository-ops.git",
    describe: "External repository URL to vendor (optional)",
  })
  .option("toolRef", {
    type: "string",
    default: process.env.TOOL_REF ?? "HEAD",
    describe: "Ref in tool-repo to checkout (branch|tag|commit)",
  })
  .option("toolDir", {
    type: "string",
    default: process.env.TOOL_DIR ?? "./",
    describe: "Target directory for vendored tool repo",
  })
  .option("push", {
    type: "boolean",
    default: (process.env.PUSH ?? "true").toLowerCase() === "true",
    describe: "Whether to push branches to origin",
  })
  .help()
  .parseSync(); // as unknown as CliArgs;

const BASE_REF = argv.baseRef;
const BASE_TAG =
  typeof argv.baseTag === "string" && argv.baseTag.trim()
    ? argv.baseTag.trim()
    : undefined;
const WORKING_BRANCH = argv.workingBranch;
const TOOL_REPO = argv.toolRepo;
const TOOL_REF = argv.toolRef;
const TOOL_DIR = argv.toolDir;
const PUSH = argv.push;

async function resolveBaseCommit() {
  const branchHead = await rev(BASE_REF);
  if (!BASE_TAG) {
    return { label: BASE_REF, commit: branchHead };
  }

  const tagCommit = await rev(BASE_TAG);
  if (!(await gitOk(["merge-base", "--is-ancestor", tagCommit, branchHead]))) {
    throw new Error(
      `指定したタグ ${BASE_TAG} は ${BASE_REF} 上に存在しません。タグは develop-upstream の履歴上にある必要があります。`,
    );
  }

  return {
    label: `${BASE_REF} (tag ${BASE_TAG})`,
    commit: tagCommit,
  };
}

async function vendorToolRepo() {
  if (!TOOL_REPO) {
    console.log(`ℹ TOOL_REPO が未指定なのでスキップ（${TOOL_DIR} は触らない）`);
    return false;
  }

  const working = fs.mkdtempSync("/tmp/tiramiss-");

  try {
    console.log(`  • clone ${TOOL_REPO}@${TOOL_REF} -> ${working}`);
    // git clone --depth=1 --branch <TOOL_REF> が理想だが、コミット/タグ/ブランチに柔軟対応するためにクローン後 checkout
    const cloneResult = await run(
      "git",
      ["clone", "--depth=1", TOOL_REPO, working],
      null,
      true,
    );
    if (cloneResult.code !== 0) {
      throw new Error(`clone failed: ${cloneResult.err}`);
    }

    // checkout ref
    const fetchResult = await run(
      "git",
      ["-C", working, "fetch", "--depth=1", "origin", TOOL_REF],
      null,
      true,
    );

    if (fetchResult.code === 0) {
      await git(["-C", working, "checkout", "FETCH_HEAD"], true);
    } else {
      // ブランチ名で shallow clone できている可能性あり。失敗しても致命ではないので続行。
    }

    // ネストした .git を除去（ベンダリング）
    console.log("  • remove nested .git (vendoring)");
    rmSync(join(working, ".git"), { recursive: true, force: true });

    // -----------------------------------------------------------------------

    // 既存の target を一旦消す（ワークツリー汚染を避ける）
    const target = TOOL_DIR;
    if (existsSync(target)) {
      console.log(`  • remove existing ${join(target, "*")}`);
      rmSync(join(target, "*"), { recursive: true, force: true });
      await git(["add", "-A", target]);
    }

    for (const src of glob.sync(`${working}/**/*`)) {
      const dest = join(target, src.replace(working, ""));
      console.log("	• copy", src, "->", dest);
      cpSync(src, dest, { recursive: true });
    }

    console.log("	• install dependencies with pnpm");
    await run("pnpm", ["install", "--frozen-lockfile"], target);

    // 追加をステージ & コミット
    await git(["add", "-A", target]);
    if (!(await gitOk(["diff", "--cached", "--quiet"]))) {
      await git([
        "commit",
        "-m",
        `ops: vendor ${target} from ${TOOL_REPO}@${TOOL_REF}`,
      ]);
      return true;
    }

    console.log("  • no changes to commit for vendored tool repo");
    return false;
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
}

(async () => {
  await ensureClean();

  console.log("▶ fetch --all --prune --tags");
  await git(["fetch", "--all", "--prune", "--tags"]);

  // WORKING_BRANCH を作成 / リセット
  const baseInfo = await resolveBaseCommit();
  console.log(`BASE: ${baseInfo.label} @ ${baseInfo.commit}`);
  if (await localBranchExists(WORKING_BRANCH)) {
    await git(["switch", WORKING_BRANCH]);
    await git(["reset", "--hard", baseInfo.commit]);
  } else {
    await git(["switch", "-C", WORKING_BRANCH, baseInfo.commit]);
  }

  // TOOL_DIR に別リポの内容をクローン（ベンダリング）
  console.log(`▶ vendor tool repo into ./${TOOL_DIR}`);
  const changed = await vendorToolRepo();

  // WORKING_BRANCH を push（変更があれば）
  if (PUSH && changed) {
    if (!(await remoteBranchExists(`origin/${WORKING_BRANCH}`))) {
      console.log("▶ push develop-working");
      await git(["push", "-u", "origin", WORKING_BRANCH]);
    } else if (changed) {
      // 作業ブランチが再構築されているはずなので強制プッシュが必要
      console.log("▶ force push develop-working");
      await git(["push", "--force", "origin", WORKING_BRANCH]);
    }
  }

  console.log("✔ pipeline done");
})().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
