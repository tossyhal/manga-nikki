# 開発手順

実装と設定を正本とし、起動・検査・変更の手順をここにまとめます。
認証・DB・AI・公開設定を扱う場合は[運用手順](docs/OPERATIONS.md)も確認してください。

## 環境構築

Git、mise、任意のエディターを用意します。Node.jsとpnpmの固定版は[mise.toml](mise.toml)・[mise.lock](mise.lock)を使います。
Node.jsやpnpmを別途更新せず、`package.json`の`packageManager`と揃えてください。
WindowsとWSLで`node_modules`を共有しません。画面のモック開発にはDockerやSupabase CLIは不要です。

```sh
mise trust
mise install --locked
pnpm install --frozen-lockfile
```

`mise trust`の前に設定内容を確認します。シェルの有効化が使えない場合は`mise exec -- pnpm ...`で実行できます。
`mise which node`・`mise which pnpm`で実際の実行先を確認できます。
EditorConfig対応を有効にし、LFとUTF-8を維持してください。

## モックで起動

初回だけ設定をコピーします。既存ファイルがある場合は上書きせず差分を確認します。
Windows PowerShellでは`cp`を`Copy-Item`へ置き換えられます。

```sh
cp .env.example .env.local
cp .dev.vars.example .dev.vars
pnpm dev
```

`local-mock`は秘密情報なしで日記入力・固定漫画・履歴を確認するモードです。
`GENERATION_ENABLED=false`を維持し、実AIキーを入れません。

## 開発用Supabaseへ接続

`local-connected`はAuth/DBと固定mock Queue経路の結合確認用です。
承認された開発用Supabaseを使い、本番の日記や認証情報を流用しません。

```sh
cp .env.example .env.local
cp dev.vars.local-connected.example .dev.vars.local-connected
pnpm dev:connected
```

起動前にコピー先へ値を設定し、接続先へレビュー済みmigrationと必要なStorage設定が適用されていることを確認します。
`.env.local`にはブラウザ公開用のSupabase URL・publishable key・Turnstile site keyだけを入れます。
`.dev.vars.local-connected`にはWorker用Supabase設定・secret key・Turnstile検証用secretと許可hostnameを設定します。
詳細なキー名はexampleを参照し、`AI_MODE=mock`・`GENERATION_ENABLED=false`を維持します。
exampleへの秘密情報の書込みや、認証・CAPTCHAの解除による回避は禁止です。
DBの検査は[supabase/README.md](supabase/README.md)を参照してください。

## 検査

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

DB変更時は`pnpm test:db`、画面変更時は`pnpm test:e2e`、PWA変更時は`pnpm test:e2e:pwa`も実行します。
E2E用Chromiumは`pnpm exec playwright install --only-shell chromium`で準備できます。
環境別設定の変更時は`pnpm test:release-environment`を実行します。
実行できなかった検査は理由を報告し、検査を弱めて成功扱いにしません。

架空サンプルのpreviewは次の手順です。

```sh
pnpm build:staging
pnpm preview
```

`build:production`と`build:demo`もローカル成果物の作成・検査だけです。公開や実AIの承認にはなりません。
環境別の公開値は対応する`.env.*.example`とbuildコードで確認してください。
個人の日記・生成画像はPWAのキャッシュへ保存しません。

## ブランチとPR

- 通常は最新`main`から目的ごとに作業ブランチを作ります。`main`へ直接コミットしません。
- Stacked PRは親ブランチをbaseにし、親側の変更はmergeで伝播します。親の統合後はbaseを`main`へ変更します。
- 変更、必要な検査、差分確認、コミットまで行います。コミットは`fix: 日記保存時の表示を修正`のように日本語1行とし、AI署名・共同作者行を付けません。
- 共有型、migration、依存関係・lockfile、Wrangler設定は編集前に担当者へ共有し、呼出し側とテストも揃えます。
- PR前に[AGENTS.md](AGENTS.md)のレビュー手順を通し、画面変更は`agent-browser`で確認します。
- [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)に検査結果、未検証事項、migration・環境変数の有無を記載します。
- pushとPR作成はユーザーの許可範囲に従い、ユーザーがMerge commitで統合します。force pushや破壊的なreset/cleanは行いません。
- `develop`への統合はstaging sample配信、`main`への統合は本番CDの対象です。配信条件は運用手順を確認してください。
