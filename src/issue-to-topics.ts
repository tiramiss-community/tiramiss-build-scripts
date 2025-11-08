import { writeFileSync } from "node:fs";
import { Octokit } from "octokit";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface Args {
	token: string;
	repo: string;
	issue: number;
	output: string;
	comments: boolean;
	prefix: string;
}

const argv = yargs(hideBin(process.argv))
	.option("token", {
		alias: "t",
		type: "string",
		describe: "GitHub personal access token or GITHUB_TOKEN",
		demandOption: true,
	})
	.option("repo", {
		alias: "r",
		type: "string",
		describe: "Target repository (owner/name)",
		demandOption: true,
	})
	.option("issue", {
		alias: "i",
		type: "number",
		describe: "Issue number to read",
		demandOption: true,
	})
	.option("output", {
		alias: "o",
		type: "string",
		default: "topics.txt",
		describe: "Output file path",
	})
	.option("comments", {
		alias: "c",
		type: "boolean",
		default: false,
		describe: "Include issue comments",
	})
	.option("prefix", {
		alias: "p",
		type: "string",
		default: "ahead/pr-",
		describe: "Prefix for PR numbers (e.g., ahead/pr-)",
	})
	.help()
	.parseSync() as Args;

async function main() {
	const { token, repo, issue, output, comments, prefix } = argv;
	const [owner, name] = repo.split("/");
	if (!owner || !name)
		throw new Error("Invalid repo format: expected owner/name");

	const octokit = new Octokit({ auth: token });

	console.log(`📋 Fetching issue #${issue} from ${repo}...`);
	const { data: issueData } = await octokit.rest.issues.get({
		owner,
		repo: name,
		issue_number: issue,
	});

	let bodyText = issueData.body ?? "";

	if (comments) {
		console.log("💬 Fetching comments...");
		const allComments = await octokit.paginate(
			octokit.rest.issues.listComments,
			{ owner, repo: name, issue_number: issue, per_page: 100 },
		);
		for (const c of allComments) bodyText += `\n${c.body ?? ""}`;
	}

	// 箇条書き抽出
	const topics: string[] = [];
	const lines = bodyText.split(/\r?\n/);
	for (const line of lines) {
		const m = line.match(/^\s*[-*]\s+(.*)$/);
		if (!m) continue;
		const raw = m[1].trim();

		// PR 番号 (#1234) → ahead/pr-1234 に変換
		const prMatch = raw.match(/#(\d+)/);
		if (prMatch) {
			topics.push(`${prefix}${prMatch[1]}`);
			continue;
		}

		// 通常のブランチ名
		if (raw.length > 0) topics.push(raw);
	}

	// 重複排除
	const unique = Array.from(new Set(topics.map((t) => t.trim()))).filter(
		Boolean,
	);

	// 出力
	const header = [
		"# Auto-generated from GitHub Issue",
		`# repo: ${repo}`,
		`# issue: #${issue}`,
		"",
	].join("\n");

	writeFileSync(output, `${header}${unique.join("\n")}\n`, "utf8");
	console.log(`✅ ${unique.length} entries written to ${output}`);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
