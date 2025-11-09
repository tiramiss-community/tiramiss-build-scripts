import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  ensureClean,
  git,
  gitOk,
  listCommits,
  localBranchExists,
  mergeBase,
  remoteBranchExists,
  rev,
} from "./utils/git";
import { run } from "./utils/proc";

type Mode = "merge" | "pick" | "squash";

const argv = yargs(hideBin(process.argv))
  .usage("$0 [options]")
  .option("baseRef", {
    type: "string",
    default: process.env.BASE_REF ?? "origin/develop-upstream",
    describe: "Base reference used to reset working branch",
  })
  .option("integrateBranch", {
    type: "string",
    default: process.env.INTEGRATE_BRANCH ?? "tiramiss",
    describe: "Final integration branch name to produce",
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
  .option("mode", {
    choices: ["merge", "pick", "squash"],
    default: (process.env.MODE as Mode) ?? "squash",
    describe: "Apply topics using chosen strategy",
  })
  .option("topics", {
    type: "string",
    default: process.env.TOPICS_FILE,
    describe: "Explicit topics file path (overrides auto search)",
  })
  .help()
  .parseSync();

const BASE_REF = argv.baseRef;
const INTEGRATE_BRANCH = argv.integrateBranch;
const TOOL_DIR = argv.toolDir;
const PUSH = argv.push;
const MODE = argv.mode;
const TOPICS_CANDIDATES = argv.topics
  ? [argv.topics]
  : [join(TOOL_DIR, "topics.txt"), "topics.txt"];

function readTopics(): { path: string | null; items: string[] } {
  for (const p of TOPICS_CANDIDATES) {
    if (existsSync(p)) {
      const items = readFileSync(p, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      return { path: p, items };
    }
  }
  return { path: null, items: [] };
}

async function resolveTopicRef(topic: string) {
  if (await gitOk(["rev-parse", "--verify", `${topic}^{commit}`])) {
    return topic;
  }
  for (const cand of [`origin/${topic}`, `upstream/${topic}`]) {
    if (await gitOk(["rev-parse", "--verify", `${cand}^{commit}`])) {
      return cand;
    }
  }
  throw new Error(`見つからないブランチ: ${topic}`);
}

async function applyMerge(topic: string) {
  if (await gitOk(["merge-base", "--is-ancestor", topic, "HEAD"])) {
    console.log(`  • skip (already merged): ${topic}`);
    return;
  }
  await git(["merge", "--no-ff", topic]);
}

async function applyPick(topic: string, baseRef: string) {
  if (await gitOk(["merge-base", "--is-ancestor", topic, "HEAD"])) {
    console.log(`  • skip (already picked): ${topic}`);
    return;
  }
  const base = await mergeBase(topic, baseRef);
  if (!base) {
    throw new Error(`merge-base 取得失敗: ${topic} vs ${baseRef}`);
  }
  const commits = await listCommits(base, topic);
  if (!commits.length) {
    console.log("   (no commits to pick)");
    return;
  }
  for (const c of commits) {
    await git(["cherry-pick", "-x", c]).catch(() => {
      throw new Error(
        "cherry-pick コンフリクト。解決後 'git add -A && git cherry-pick --continue' を実行し、再実行してください。",
      );
    });
  }
}

async function applySquash(topic: string) {
  const common = await mergeBase("HEAD", topic);
  const diff = await run(
    "git",
    ["diff", "--quiet", `${common}..${topic}`, "--"],
    null,
    true,
  );
  if (diff.code === 0) {
    console.log(`  • skip (no diff): ${topic}`);
    return;
  }
  const mergeResult = await run("git", [
    "merge",
    "--squash",
    "--no-commit",
    topic,
  ]);
  if (mergeResult.code !== 0) {
    throw new Error(
      "squash コンフリクト。解決後 'git commit' して再実行してください。",
    );
  }
  const headSubj = await git(["log", "-1", "--pretty=%s", topic], true);
  await git([
    "commit",
    "-m",
    `squash(${topic.split("/").pop() ?? topic}): ${headSubj}`,
    "-m",
    `Squashed from '${topic}'`,
  ]);
}

(async () => {
  await ensureClean();

  const { path: topicsPath, items: topics } = readTopics();
  if (!topicsPath) {
    console.log("ℹ topics.txt が見つかりません。");
    return;
  }

  // tiramiss を作成/更新（INTEGRATE_BRANCH の先頭から）
  const workingHead = await rev("HEAD");
  if (await localBranchExists(INTEGRATE_BRANCH)) {
    await git(["switch", INTEGRATE_BRANCH]);
    await git(["reset", "--hard", workingHead]);
  } else {
    await git(["switch", "-C", INTEGRATE_BRANCH, workingHead]);
  }

  // topics を適用
  console.log(
    `▶ apply topics (${MODE}) from ${topicsPath}: ${topics.length} entries`,
  );
  for (const raw of topics) {
    const topic = await resolveTopicRef(raw);
    console.log(`  • ${topic}`);
    if (MODE === "merge") {
      await applyMerge(topic);
    } else if (MODE === "pick") {
      await applyPick(topic, BASE_REF);
    } else {
      await applySquash(topic);
    }
  }

  if (PUSH) {
    if (!(await remoteBranchExists(`origin/${INTEGRATE_BRANCH}`))) {
      await git(["push", "-u", "origin", INTEGRATE_BRANCH]);
    } else {
      await git(["push", "origin", INTEGRATE_BRANCH]);
    }
  }

  console.log("✔ pipeline done");
})().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
