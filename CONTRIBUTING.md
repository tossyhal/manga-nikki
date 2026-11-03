# 開発手順（CONTRIBUTING）

## 1. 最初にやること（ツールの準備）

初期基盤と固定版の設定は追加済みです。この節でツールとエディターを準備し、次の節で開発サーバーを起動します。

### ツールと採用バージョン

Git、mise、任意のエディターを用意します。Node.jsは`24.22.1`、pnpmは`12.11.2`に固定済みです。miseも検証した`2026.10.19`以降を使います。

Node.jsとpnpmはmise、依存パッケージはpnpmと`pnpm-lock.yaml`で管理します。package.jsonの`packageManager`には`pnpm@12.11.2`を設定します。WindowsとWSLで`node_modules`を共有しません。通常の画面開発にDockerやSupabase CLIは不要です。

### Windowsのmise導入

1. PowerShellで次を実行します。既にmiseがあればインストールは不要です。

   ```powershell
   winget install jdx.mise
   ```

2. ターミナルを開き直し、`mise --version`で認識されることを確認します。
3. 現在のPowerShellでmiseを有効にします。

   ```powershell
   (&mise activate pwsh) | Out-String | Invoke-Expression
   ```

4. 毎回有効にするには、`$PROFILE`が示すプロファイルに同じ有効化の1行を一度だけ追加します。ファイルがなければ親フォルダーごと作成し、既存の内容は残します。VS Code内のPowerShellと別のPowerShellでは、使うプロファイルが異なる場合があります。
   プロファイルを開く操作例です。開いたファイルへ有効化の1行を追記して保存します。

   ```powershell
   if (-not (Test-Path $PROFILE)) {
       New-Item -ItemType File -Path $PROFILE -Force | Out-Null
   }
   notepad $PROFILE
   ```

5. 新しいターミナルで再確認します。プロファイル実行が制限されている場合は設定を無条件に緩めず、下の`mise exec`方式を使います。

macOSはHomebrew導入済みなら`brew install mise`、Linux/WSLは[公式インストール手順](https://mise.jdx.dev/installing-mise.html)に従います。シェル設定はzshなら`~/.zshrc`へ`eval "$(mise activate zsh)"`、bashなら`~/.bashrc`へ`eval "$(mise activate bash)"`を一度だけ追加します。mise本体がPATHにない場合は、公式手順に従ってからターミナルを開き直します。

### エディターと改行

VS Codeでリポジトリを開き、拡張機能の推奨一覧からEditorConfig拡張をインストールします。[推奨拡張の設定](.vscode/extensions.json)は自動インストールではありません。他のエディターでもEditorConfig対応を有効にしてください。

`.editorconfig`は保存時のLF・文字コード・インデント、`.gitattributes`はGitのテキスト改行をLFへ揃えます。個人の`core.autocrlf`設定を変更する必要はありません。日本語と英数字の間に不要な半角スペースは入れず、コード・URL・コマンド内の空白は維持します。

## 2. 初回起動

リポジトリにある4つの設定・lockfileを使います。既にclone済みなら取得を繰り返しません。招待を承諾したGitHubアカウントで認証し、URLにトークンを埋め込みません。

```powershell
git clone https://github.com/tossyhal/manga-nikki.git
cd manga-nikki
```

リポジトリの`mise.toml`を確認してから信頼し、固定版を導入します。

```powershell
mise trust
mise install --locked
node --version
pnpm --version
```

pnpmが`12.11.2`であり、Node.jsが`mise.lock`の版と一致することを確認します。別のインストール先が優先される場合は、`mise which node`・`mise which pnpm`で切り分けます。シェル有効化を使えない場合は、以降のコマンドを`mise exec -- pnpm ...`の形で実行できます。

```powershell
pnpm install --frozen-lockfile
```

設定ファイルを初回だけコピーします。既存ファイルがある場合は上書きせず差分を確認します。macOS/Linux/WSLは`Copy-Item`を`cp`へ置き換えます。

```powershell
Copy-Item .env.example .env.local
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

初期設定は[動作モード対応表](docs/ARCHITECTURE.md#mode-matrix)の`local-mock`です。秘密情報（APIキーなど）を用意せず、localhostで入力→固定漫画→履歴を確認します。実クラウドへの接続は[OPERATIONS](docs/OPERATIONS.md)を参照してください。PowerShellで`pnpm.ps1`が拒否されたら`pnpm.cmd`を試します。

## 3. 初期基盤の範囲

- [ARCHITECTURE](docs/ARCHITECTURE.md)のclient/server/shared構成と、[API](docs/API.md)の共有Zod schemaを用意する。
- 4ルート、health/config、モックの保存・生成APIで日記入力→固定4コマ→保存・再取得を通す。
- 標準コマンド・lint/format・型確認・unit/E2E・CIを用意し、秘密情報なしの新規Windows環境で起動と検査が通ることを確認する。
- モック表示、localhost制限、動作モードの起動時検証を入れる。DB・Queue・実AI・本番公開は後続PRで扱う。

以下は基盤設定を更新するときだけの参考です。通常の参加者は作り直さず、前節の`--locked`で導入します。

```sh
mise use node@24.22.1 pnpm@12.11.2
mise lock --platform linux-x64,windows-x64,macos-arm64,macos-x64
```

利用者のOS/CPUに合わせて対象を追加し、各環境で`mise install --locked`を確認します。Node.jsの解決版とpnpmの指定版を確認し、miseの設定・lockfileを一緒に管理します。package.jsonの`packageManager`とCIも同じ版へ揃えます。

## 4. 標準コマンド一覧

初期基盤のコマンドと日記DBテストは実装済みです。公開用コマンドは後続で追加し、package.jsonの`scripts`を正本とします。

| コマンド | 用途 | いつ用意するか |
|---|---|---|
| `pnpm dev` | 画面とAPIの開発サーバー | 実装済み |
| `pnpm lint` | 静的ルール検査 | 実装済み |
| `pnpm typecheck` | TypeScriptの型検査 | 実装済み |
| `pnpm test` | Vitestの非watch実行 | 実装済み |
| `pnpm test:e2e` | PlaywrightのモックE2E | 実装済み |
| `pnpm build` | ビルド検証。公開しない | 実装済み |
| `pnpm format` / `pnpm format:check` | 整形 / 整形の検査 | 実装済み |
| `pnpm test:db` | 隔離PostgreSQLの日記RLS/RPC・同時要求 | 実装済み（PostgreSQL 16が必要） |
| `pnpm build:staging` / `pnpm build:production` | 環境別ビルド | 公開準備時 |
| `pnpm deploy:staging` / `pnpm deploy:production` | 承認済み環境への公開 | 公開準備時 |

`pnpm-workspace.yaml`の`allowBuilds`でesbuildとworkerdだけのインストールスクリプトを許可しています。知らない依存を一括承認せず、変更時はレビューします。CIはUbuntuだけで実行し、mise-actionで同じ版を導入します。同じブランチの古い実行はキャンセルします。scriptsはWindowsでも動くコマンドで書き、シェル固有のコピー・削除・環境変数代入は避けます。

実AIは通常CIで呼びません。未実装のコマンドを確認済みと報告せず、lockfile不一致は版・ブランチの差を確認します。`--frozen-lockfile`を外して再生成しません。Playwrightのブラウザ導入は採用版の公式手順に従います。

DB基盤の変更時は`pnpm test:db`も実行します。PostgreSQLの準備・テストの範囲・保存API担当へのRPC契約は[supabase/README.md](supabase/README.md)を参照してください。通常の画面開発にはPostgreSQLは不要です。

## 5. ブランチ運用とPull Request（PR）の進め方

### ① 作業ブランチの作成

必ず最新の`main`ブランチから作業ブランチを作成し、「1タスク＝1PR」の小さな単位で進めます。
作業を始める前に、`git status`で未コミットの変更がないことを確認してください。

```sh
git switch main
git pull --ff-only origin main
git switch -c feat/diary-form
```

### ② 変更の確認とコミット

1. コードを変更したら、関連する標準コマンド（`pnpm lint`、`pnpm typecheck`、`pnpm test`など）と`git diff`で変更内容を確認します。
2. `git add <ファイル名>`で追加するファイルを個別に指定します。
3. コミット前に必ず`git diff --cached`を実行し、秘密情報や無関係な変更が含まれていないことを確認します。
4. コミットメッセージは`feat: 日記入力を追加`のようにConventional Commits形式＋日本語1行で作成します（AIの署名や`Co-authored-by`行は付けません）。

### ③ PRの作成とレビュー

1. ブランチをpushし、GitHub上でbaseブランチを`main`とするPRを作成します。
2. PRの本文には「変更理由」「確認手順と結果」「未検証の項目」を記載します。画面の変更がある場合はスクリーンショットも添付してください（作業途中の場合はDraft PRにします）。
3. レビューは変更者以外のチームメンバーに依頼します。
   - 認証・RLS・RPC・予算制限・公開設定・DB migrationに関わる変更は、人間によるレビューを必須とします。
   - AIツールが生成したコードであっても、PRを出す担当者自身が「何を入力して何が出力されるか」「どう動作確認したか」を説明できるようにしてください。

### ④ マージとブランチの更新

- マージ方法：レビュー承認後、Merge commitで統合します（Squash mergeやRebase mergeには変更しないでください）。
- 禁止事項：`main`ブランチへの直接コミット、`force push`、他人のコミット履歴の書き換えは禁止です。
- CIの必須化：GitHub ActionsのCIをrequired check（マージ必須条件）に設定するのは、実際に成功するジョブが動いてからにします。
- 作業中に`main`が進んだ場合：
  - 作業ブランチ上で`git fetch origin` → `git merge origin/main`を実行して取り込みます。
  - 競合（コンフリクト）が起きた際、自分の担当外のコードを消して解消しないでください。
  - 共有型・lockfile・wrangler設定などを複数人で同時に触る必要がある場合は、事前に相談してください。
- マージ後の片付け：`main`ブランチを最新に更新（`git switch main && git pull --ff-only`）し、マージ済みの自分の作業ブランチだけを`git branch -d <ブランチ名>`で削除します。

---

## 6. 困ったとき・実装時の参考リンク

### 15〜30分詰まったらSlackで相談

エラーや手順で15〜30分ほど手が止まったら、一人で抱え込まずに以下の項目をSlackで共有してください（※秘密情報やトークンは貼らないこと）。

- 担当しているIssue / 作業ブランチ名
- やりたいこと
- 実行したコマンド
- 実際の結果（エラー文など）と、期待していた結果
- すでに試したこと

※ 画像が表示されないトラブルの場合でも、Storageのprivate（非公開）設定は解除せず、「所有者」「署名URLの有効期限」「接続先設定」を確認してください。

### 公式ガイドの参照（基盤構築・DB担当向け）

- 初期基盤の構築時：
  [Cloudflare Workers × Hono公式ガイド](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)を確認し、テンプレートはリポジトリ外の一時ディレクトリで生成してから、必要なファイルだけを取り込みます。
- DB migrationの作業時：
  [Supabase公式migration手順](https://supabase.com/docs/guides/local-development/database-migrations/)を確認し、「ローカルDBのreset」と「共有DBへのmigration適用」を明確に区別してください。**共有DBや本番DBではresetを実行しないでください。**（CLIの具体的な操作手順は、採用バージョンの動作確認後に追記します）。

miseの導入・シェル有効化・lockfileの説明は2026-10-27に[公式導入手順](https://mise.jdx.dev/installing-mise.html)・[シェル設定](https://mise.jdx.dev/shell-setup.html)・[lockfile仕様](https://mise.jdx.dev/dev-tools/mise-lock.html)と手元のmiseのhelpを確認しました。Windows/macOSでの起動は未検証です。


## 開発モックの制限

- 本文と結果はWorkerのメモリだけに保存します。ブラウザ再読込では取得できますが、開発サーバー再起動やHMRで消える場合があります。
- 表示する漫画は入力内容とは無関係の固定サンプルです。入力本文は別に保存します。実データを入れないでください。
- liveモードのSupabase JWT検証境界は実装済みです。DB接続・日記CRUD・CAPTCHA・Queue・実AI・30日期限削除・PWAは未実装で、個人APIはJWT検証後も503を返します。サンプルモードは個人APIを認証せず拒否します。
- ビルド結果はサンプル配信向けです。コンパイル済みWorkerはモック認証を拒否するため、`pnpm preview`は日記保存の動作確認には使いません。
- E2E初回は`pnpm exec playwright install chromium`、実行は`pnpm test:e2e`です。Windowsの実機確認はCIの結果と分けて報告します。
