# tiramiss-build-scripts 向け Copilot ガイド

## プロジェクト概要
- tiramiss フォーク運用（upstream 追従、作業ブランチ再構築、トピック適用）を自動化するためのスクリプト群です。
- 実行は `pnpm run <task>` + Vite Node で行い、GitHub Actions でも `.tiramiss` 配下に vendoring した同じエントリーポイントを再利用します。
- 主要ソースは `src/`、ワークフローのひな型は `workflows/` に置き、rebuild ジョブが `.github/workflows` へコピーします。

## 主なエントリーポイント
- `src/sync-upstream.ts`: `upstream/develop` を `develop-upstream` に取り込みます（remote 自動追加、merge、必要なら push）。
- `src/rebase-working-branch.ts`: `develop-working` をベース ref から再生成し、外部 repository-ops を `TOOL_DIR` に vendoring、依存インストール、必要に応じて force push します。
- `src/issue-to-topics.ts`: GitHub Issue のチェックリストを解析し、指定ラベルを持つ PR の head ブランチを抽出して `topics.txt` に書き出します。
- `src/apply-topics.ts`: `topics.txt` のブランチを integration ブランチへ `merge` / `pick` / `squash` モードで適用し、Co-authored-by などのメタ情報も維持します。
- 共通ユーティリティは `src/utils/`（プロセス実行は `proc.ts`, git ラッパーは `git.ts`）。`child_process` 直叩きではなく既存ラッパーを優先してください。

## 実行環境とツール
- Node.js 24 + pnpm + TypeScript (NodeNext, ES2022, `noEmit`) を前提とします。
- フォーマット/リンタは Biome（`pnpm run format:fix`）。ダブルクオートと 2 スペースインデントが標準です。
- CLI オプションは `yargs` の `.option` で宣言し、既存スクリプト同様に環境変数で上書きできるようにします。
- git などのコマンドは `await git([...])` / `await run(cmd, args, cwd, quiet)` を使ってログ一貫性とエラー処理を保ちます。

## コーディングスタイルとエラーハンドリング
- 非同期は async/await で統一し、生 Promise チェーンは避けます。
- 失敗時は状況が分かる `Error` を投げ、必要に応じて日本語の補足も含めます。
- 破壊的な git 操作（ブランチ書き換え等）は事前に `ensureClean()` を呼びます。
- ログはシンプルな `console.log` プレフィックスを踏襲し、CI ログでも追いやすく保ちます。

## ツール群の拡張指針
- 新しいスクリプトは `src/` に配置し `pnpm run <name>` から呼べるよう script を追加します。
- ワークフローを増やす場合は `workflows/` にテンプレを置き、rebuild で `.github/workflows` へコピーされる前提を維持します。
- `mergeBase`, `listCommits`, `gitOk` など既存ヘルパーを組み合わせ、低レベルな git コマンド構築を繰り返さないようにします。
- 秘密情報はリポジトリに含めず、CLI 引数や環境変数で受け取る設計にしてください。

## 検証チェックリスト
- 作業前に `pnpm install --frozen-lockfile` を実行し依存を固定します。
- 各スクリプトはリポジトリルート・クリーン状態で `pnpm run <task>` を叩いてスモークテストします。
- `pnpm run format:fix` で Biome のフォーマット/リンタを通し、CI のスタイルチェックを満たします。

## 非目標と注意事項
- 他リポジトリ操作や過剰な自動化は持ち込みません。対象は現在のクローンと vendoring 済みツールに限定します。
- Nest.js / Express などフレームワーク層を追加しないでください。軽量 CLI に留めます。
- force push が関わる箇所ではローカル/リモートの存在を確認し、既存パターンに倣って安全策を入れます。
