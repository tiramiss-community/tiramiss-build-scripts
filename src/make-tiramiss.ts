/* eslint-disable no-console */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Mode = "merge" | "pick" | "squash";

const BASE_REF = process.env.BASE_REF ?? "origin/develop-upstream";
const WORKING_BRANCH = process.env.WORKING_BRANCH ?? "develop-working";
const INTEG_BRANCH = process.env.INTEG_BRANCH ?? "tiramiss";

const TOOL_REPO = process.env.TOOL_REPO ?? ""; // 例: https://github.com/you/tiramiss-build-scripts.git
const TOOL_REF = process.env.TOOL_REF ?? "HEAD"; // 例: main / v1.2.3 / <commit>
const TOOL_DIR = process.env.TOOL_DIR ?? "tiramiss"; // 展開先サブディレクトリ
const PUSH = (process.env.PUSH ?? "true").toLowerCase() === "true";

const MODE = (process.env.MODE as Mode) ?? "squash"; // merge | pick | squash
const TOPICS_CANDIDATES = [join(TOOL_DIR, "topics.txt"), "topics.txt"];

function run(cmd: string, args: string[], quiet = false) {
	return new Promise<{ code: number; out: string; err: string }>(
		(resolve, reject) => {
			const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			let out = "",
				err = "";
			p.stdout.on("data", (d) => {
				const s = d.toString();
				out += s;
				if (!quiet) process.stdout.write(s);
			});
			p.stderr.on("data", (d) => {
				const s = d.toString();
				err += s;
				if (!quiet) process.stderr.write(s);
			});
			p.on("error", reject);
			p.on("close", (code) => resolve({ code: code ?? 0, out, err }));
		},
	);
}
async function git(args: string[], quiet = false) {
	const r = await run("git", args, quiet);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.err}`);
	return r.out.trim();
}
async function gitOk(args: string[]) {
	return (await run("git", args, true)).code === 0;
}
async function ensureClean() {
	const s = await git(["status", "--porcelain"], true);
	if (s.trim())
		throw new Error(
			"作業ツリーがクリーンではありません。コミット or stash してください。",
		);
}
async function rev(ref: string) {
	return git(["rev-parse", "--verify", `${ref}^{commit}`], true);
}
async function localBranchExists(n: string) {
	return gitOk(["show-ref", "--verify", `refs/heads/${n}`]);
}
async function remoteBranchExists(n: string) {
	return gitOk(["show-ref", "--verify", `refs/remotes/${n}`]);
}
async function mergeBase(a: string, b: string) {
	return git(["merge-base", a, b], true);
}
async function listCommits(base: string, head: string) {
	const out = await git(
		["rev-list", "--reverse", "--ancestry-path", `${base}..${head}`],
		true,
	);
	return out ? out.split("\n").filter(Boolean) : [];
}
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
	if (await gitOk(["rev-parse", "--verify", `${topic}^{commit}`])) return topic;
	for (const cand of [`origin/${topic}`, `upstream/${topic}`]) {
		if (await gitOk(["rev-parse", "--verify", `${cand}^{commit}`])) return cand;
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
	if (!base) throw new Error(`merge-base 取得失敗: ${topic} vs ${baseRef}`);
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
		true,
	);
	if (diff.code === 0) {
		console.log(`  • skip (no diff): ${topic}`);
		return;
	}
	const m = await run("git", ["merge", "--squash", "--no-commit", topic]);
	if (m.code !== 0)
		throw new Error(
			"squash コンフリクト。解決後 'git commit' して再実行してください。",
		);
	const headSubj = await git(["log", "-1", "--pretty=%s", topic], true);
	await git([
		"commit",
		"-m",
		`squash(${topic.split("/").pop() ?? topic}): ${headSubj}`,
		"-m",
		`Squashed from '${topic}'`,
	]);
}

async function vendorToolRepo() {
	if (!TOOL_REPO) {
		console.log("ℹ TOOL_REPO が未指定なのでスキップ（./tiramiss は触らない）");
		return false;
	}
	const target = TOOL_DIR;
	// 既存の ./tiramiss を一旦消す（ワークツリー汚染を避ける）
	if (existsSync(target)) {
		console.log(`  • remove existing ./${target}`);
		rmSync(target, { recursive: true, force: true });
		await git(["add", "-A", target]); // 削除をステージ
	}

	console.log(`  • clone ${TOOL_REPO}@${TOOL_REF} -> ./${target}`);
	// git clone --depth=1 --branch <TOOL_REF> が理想だが、コミット/タグ/ブランチに柔軟対応するためにクローン後 checkout
	const r1 = await run("git", ["clone", "--depth=1", TOOL_REPO, target], true);
	if (r1.code !== 0) throw new Error(`clone failed: ${r1.err}`);
	// checkout ref
	const r2 = await run(
		"git",
		["-C", target, "fetch", "--depth=1", "origin", TOOL_REF],
		true,
	);
	if (r2.code === 0) {
		await git(["-C", target, "checkout", "FETCH_HEAD"], true);
	} else {
		// ブランチ名で shallow clone できている可能性あり。失敗しても致命ではないので続行。
	}
	// ネストした .git を除去（ベンダリング）
	console.log("  • remove nested .git (vendoring)");
	rmSync(join(target, ".git"), { recursive: true, force: true });

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
}

(async () => {
	await ensureClean();
	console.log("▶ fetch --all --prune");
	await git(["fetch", "--all", "--prune"]);

	// 1) develop-working を作成 / リセット
	const base = await rev(BASE_REF);
	console.log(`BASE: ${BASE_REF} @ ${base}`);
	if (await localBranchExists(WORKING_BRANCH)) {
		await git(["switch", WORKING_BRANCH]);
		await git(["reset", "--hard", base]);
	} else {
		await git(["switch", "-C", WORKING_BRANCH, base]);
	}

	// 2) ./tiramiss に別リポの内容をクローン（ベンダリング）
	console.log(`▶ vendor tool repo into ./${TOOL_DIR}`);
	const changed = await vendorToolRepo();

	// 3) develop-working を push（変更があれば）
	if (
		PUSH &&
		(changed || !(await remoteBranchExists(`origin/${WORKING_BRANCH}`)))
	) {
		console.log("▶ push develop-working");
		await git(["push", "-u", "origin", WORKING_BRANCH]);
	} else if (PUSH && changed) {
		await git(["push", "origin", WORKING_BRANCH]);
	}

	// 4) tiramiss を作成/更新（develop-working の先頭から）
	const workingHead = await rev("HEAD");
	if (await localBranchExists(INTEG_BRANCH)) {
		await git(["switch", INTEG_BRANCH]);
		await git(["reset", "--hard", workingHead]);
	} else {
		await git(["switch", "-C", INTEG_BRANCH, workingHead]);
	}

	// 5) topics を適用
	const { path: topicsPath, items: topics } = readTopics();
	if (!topicsPath) {
		console.log(
			"ℹ topics.txt が見つかりません。./tiramiss を載せただけで終了します。",
		);
	} else {
		console.log(
			`▶ apply topics (${MODE}) from ${topicsPath}: ${topics.length} entries`,
		);
		for (const raw of topics) {
			const topic = await resolveTopicRef(raw);
			console.log(`  • ${topic}`);
			if (MODE === "merge") await applyMerge(topic);
			else if (MODE === "pick") await applyPick(topic, BASE_REF);
			else await applySquash(topic);
		}
	}

	// 6) tiramiss を push
	if (PUSH) {
		if (!(await remoteBranchExists(`origin/${INTEG_BRANCH}`)))
			await git(["push", "-u", "origin", INTEG_BRANCH]);
		else await git(["push", "origin", INTEG_BRANCH]);
	}

	console.log("✔ pipeline done");
})().catch((e) => {
	console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
