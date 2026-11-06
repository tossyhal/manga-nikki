# Stagingデプロイ運用

この文書はstaging Workerの初期作成と、架空sample専用CDの運用を記録します。初期作成用資格情報は退役済みです。Supabase接続や本番Workerの作成・配信は扱いません。

## 2026-11-06時点の状態

- `manga-nikki-staging` Workerは初期作成済みです。初期作成用Cloudflare tokenの失効とBitwarden上の`CLOUDFLARE_BOOTSTRAP_API_TOKEN`削除、GitHubの`BWS_BOOTSTRAP_SECRET_ID`削除はownerから完了報告を受けています。Cloudflare APIによる失効監査は行っていません。
- staging Environmentの`BWS_ACCESS_TOKEN`、`BWS_CLOUDFLARE_SECRET_ID`、`STAGING_WORKER_URL`は通常CD用です。Secret IDの実値はGitHubだけに置き、この文書やworkflowへ記載しません。
- 公開先は`https://manga-nikki-staging.tossyhal.workers.dev`です。Repository variable`STAGING_SAMPLE_CD_ENABLED`は未設定のため、sample CDは現在無効です。
- staging Environmentの許可branchを`develop`だけに切り替えるまでは、通常CDを有効化しないでください。
- 旧`bootstrap-staging.yml`は初期作成記録として残しています。`BWS_BOOTSTRAP_SECRET_ID`を削除済みのため退役扱いとし、再実行しません。

## 通常staging sample CDの有効化

このworkflowは公開の架空sampleだけを配信します。Cloudflare Accessを設定せず、閲覧者がアクセスできるworkers.dev URLに公開します。日記本文・個人DB・Supabase/Auth/Turnstile・AI秘密情報は使いません。実AI生成、Queue、Cron、production配信は行いません。

### 必須設定

| 設定場所 | 名前 | 内容 |
| --- | --- | --- |
| GitHub staging Environment Secret | `BWS_ACCESS_TOKEN` | `manga-nikki-dev-cd`のBitwarden machine account token |
| GitHub staging Environment Variable | `BWS_CLOUDFLARE_SECRET_ID` | Bitwardenにあるstaging Worker専用Cloudflare API tokenのSecret ID（UUID） |
| GitHub staging Environment Variable | `STAGING_WORKER_URL` | `https://manga-nikki-staging.tossyhal.workers.dev` |
| GitHub Repository Variable | `STAGING_SAMPLE_CD_ENABLED` | ownerが全条件確認後に`true`へ設定。未設定・他の値は無効 |

Bitwarden machine accountは`manga-nikki-dev` project全体をread-onlyで読めるため、project内にある既存の開発用Supabase secret等も読める権限です。sample CDのworkflowは`BWS_CLOUDFLARE_SECRET_ID`に指定されたCloudflare token 1件だけをActionへ要求し、Supabase secretやAI secretを取得するstepはありません。本番用secretはこのdev projectへ保存しないでください。通常のCloudflare API token自体は既存`manga-nikki-staging`だけを更新できるscopeにします。

### 有効化前チェック

1. このPRをownerがレビューし、`main`へMerge commitで取り込みます。
2. 初期作成用Cloudflare tokenが失効済みで、Bitwardenからも削除済みであることを確認します。GitHubの`BWS_BOOTSTRAP_SECRET_ID`が残っていないことも確認します。
3. `develop`を`main`のHEADから作成します。`develop`のRulesetでPR必須、直接更新・force push・削除を禁止し、必須checkを`database`と`check`に設定します。checkの提供元はGitHub Actions app（ID `15368`）に固定します。
4. GitHubの`staging` EnvironmentのDeployment branches and tagsをselected branchesにし、`develop`だけを許可します。ここで上記の通常CD用secretとvariablesを確認します。
5. Ownerが公開URL・Worker名・token scope・ruleset・Environment branch制限を確認してから、Repository variable`STAGING_SAMPLE_CD_ENABLED=true`を明示設定します。

variableの設定だけでは新しいworkflow runを起動しません。初回配信は[CI workflow](https://github.com/tossyhal/manga-nikki/actions/workflows/ci.yml)を開き、**Run workflow**でbranch`develop`を選んで実行します。`database`と`check`が成功し、最後に`staging-deploy`が配信・smoke確認を完了したことを確認してください。`main`へのmergeだけではsample公開は始まりません。

以後は`develop`へのpush後、`database`と`check`の両方が成功した場合だけstaging jobへ進みます。手動実行も`develop`からに限ります。PR、`main`、他branchではBitwarden/Cloudflare credentialsを取得しません。staging jobは`manga-nikki-deploy-staging`で直列化し、最大100件までpending runを待機させます。待機はConcurrency groupへ入った順のFIFOですがSHA順ではありません。各jobはdeploy直前に`develop` HEADを再確認し、実行SHAが最新HEADと異なればskipします。queueが100件で埋まると追加runはcancelされるため、その場合はqueue解消後に最新版を手動実行します。

### 配信前後の検査

- `pnpm build:staging`後、`.env.staging.local`がないこと、pluginが生成したconfigが`dist`内の通常ファイルであること、Worker名・mode・URL設定・空Cron・bindingなし・`.dev.vars`なしであることを確認します。
- 既存WorkerのCloudflare settingsだけをGETし、Workerが存在しない場合は停止します。secret・Queueその他の予期しないbindingがある場合も停止し、Workerを新規作成しません。
- deploy直前にGitHub APIから`develop` HEADを再確認します。実行SHAと異なる場合はskipとしてSummaryへ記録し、Cloudflareへ変更要求を送りません。同じSHAの再実行は許可します。
- 配信後はWorker settingsの4つのsample用plain text varsと、assets bindingが0〜1件で余分なbindingがないこと、workers.dev有効・preview URL無効を確認します。sample状態は配信物の`/__deployment.json` markerでも照合します。公開URLからhealth/config/markerを読み、status `ok`、`sample`、生成無効、同じSHAを検査します。公開GETに認証tokenを送らず、HTMLのAccessログイン画面や異なるSHAを成功扱いにしません。
- 公開GETの検査だけ最大5回まで3秒間隔で再試行し、Wrangler deploy自体は再実行しません。Summaryにversion IDは表示せず未取得と記録します。

### 失敗後の確認と再実行

- `pnpm install`・build・Secret ID検査・Bitwarden取得で止まった場合はdeploy scriptに到達していないため、このjobのdeployment summaryはありません。run URLの失敗stepを確認します。
- deploy開始後にcancel/timeoutした場合やpost-deploy検査に失敗した場合は、Cloudflare側へ反映済みか不明、または新versionが反映済みの可能性があります。自動rollbackはしません。run URL、[Workers管理画面](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/workers-and-pages)の現在version ID、公開URLの`/__deployment.json`のcommitを照合し、最新`develop` HEADを確認します。
- 最新のcommitを配信し直す場合は[CI workflow](https://github.com/tossyhal/manga-nikki/actions/workflows/ci.yml)を開き、**Run workflow**から`develop`を選びます。古いrunの再実行はHEAD guardによりskipされることがあります。
- rollbackが必要な場合は、最後に正常確認したversion IDへCloudflare管理画面の別操作で戻します。自動rollbackはありません。

## 初期Worker作成の履歴（退役済み）

初期Worker作成は完了し、以後の運用はこの文書の通常staging sample CD手順を使います。旧bootstrap workflowと手順は再実行しません。

- [初期Worker作成run](https://github.com/tossyhal/manga-nikki/actions/runs/42084008640)
- [通常token読取check run](https://github.com/tossyhal/manga-nikki/actions/runs/42085998783)
- [退役前の初期設定手順](https://github.com/tossyhal/manga-nikki/blob/0789d08ba24790bf100ac3597467ff4bf17957d8/docs/DEPLOYMENT.md)
- 初期作成用Cloudflare tokenの失効、Bitwarden上の旧secret削除、GitHubの旧Secret ID削除はownerから完了報告を受けています。Cloudflare API監査は未実施です。
- devのCloudflare Accessは導入しません。sample URLは公開し、架空データだけを扱います。

## 公式資料

- [BitwardenのGitHub Actions連携](https://bitwarden.com/help/github-actions-integration/)
- [Workersの権限とスコープ](https://developers.cloudflare.com/workers/authorization/workers/)
- [Wranglerのworkers.dev・preview URL設定](https://developers.cloudflare.com/workers/wrangler/configuration/)
