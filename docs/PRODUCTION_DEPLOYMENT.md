# Production connected CD運用

この手順は既存production Workerへ日記CRUD接続版を配信するowner限定CIを扱います。productionは`APP_ENV=production`・`DATA_MODE=live`・`AI_MODE=live`・`GENERATION_ENABLED=false`で動きます。実AIは停止し、Queue bindingとOpenAI keyは設定しません。公開前にroute/domainと匿名Auth・保存動作を確認します。

## 現在の状態

- `manga-nikki` Worker、production Environment、Bitwarden machine account、Worker用Cloudflare token、Turnstile widgetの初期設定はowner報告済みです。CloudflareとBitwardenの権限scopeは独立監査していません。
- 既存WorkerはHello World 0 vars/secrets状態から接続版へ移行できます。固定URLは登録済みですが、owner報告で到達性は未確認です。CDは既存Worker以外を作成しません。
- `production` Environmentは`main`だけを許可します。Environment secret `BWS_ACCESS_TOKEN`はproduction用Bitwarden machine account tokenです。
- 2026-11-06のGitHub API readbackで、activeなruleset `main-owner-merge-only`（ID `26636985`）は`refs/heads/main`への更新を制限し、User ID `92223710`だけが`pull_request`経由でbypassできます。activeな`protect-main`（ID `25877767`）はPRとmerge commitを必須にし、force pushと削除を禁止、bypassなしです。mainとworkflowの変更はownerによるPR mergeが必要で、他collaboratorの直接更新・mergeはできません。
- Environment variablesは`BWS_CLOUDFLARE_SECRET_ID`、`BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID`、`BWS_SUPABASE_SECRET_KEY_SECRET_ID`、`BWS_TURNSTILE_SITE_KEY_SECRET_ID`、`BWS_TURNSTILE_SECRET_KEY_SECRET_ID`、`PRODUCTION_WORKER_URL`、`PRODUCTION_CONNECTED_CD_ENABLED`です。
- `PRODUCTION_CONNECTED_CD_ENABLED=false`です。flagが`true`でない場合は成功skipし、BWS / Cloudflareへ接続しません。旧`PRODUCTION_SAMPLE_CD_ENABLED`を参照せずsample fallbackもしません。
- Build前は公開用publishable key/site keyの2件だけを取得します。build後にmain gateを再確認してから、Cloudflare tokenと2つのWorker secretを取得します。AI用secretは読み出しません。
- 同名のRepository / Organization variableは作成しません。Environment variableを削除すると下位scopeの同名variableが使われる可能性があるため、停止時も削除せず`false`を設定します。

## 実行条件と対象

CD jobは`database`・`check`が成功した`main`へのpush、または`main`を選んだ手動実行だけを対象にします。checkout後にmiseで固定Node.js `24.22.1`とpnpmを設定してから、Repository、`github.actor_id=92223710`、`github.triggering_actor=tossyhal`、production Environmentのmain-only制限を確認します。直列化後のpreflightがSHAを検査し、Environment flagが有効でなければ成功skipして停止します。無効時もcheckoutとmiseのruntime setupは行いますが、GitHub APIでのmain HEAD照会、`pnpm install`、build、Bitwarden、Cloudflareには進みません。jobは`manga-nikki-deploy-production`で直列化され、pending runを最大数待機させます。

最初のgateは固定Node準備後に実行し、flag、実行SHA、Repository、main、actor、固定Worker URL、5つのSecret ID形式を確認します。無効flagではGitHub API main照会、package install、BWS、Cloudflareへ進みません。有効時は公開key2件でbuildし、private credential取得前にgateを再実行します。deploy scriptはさらに最新mainを確認し、Cloudflare settingsとSupabase probe後にもう一度mainを確認してからdeployします。

| 項目 | 固定値 |
| --- | --- |
| Cloudflare account | `c9cee9599752cb191815c0eea6ff457e` |
| Worker | `manga-nikki` |
| 公開予定URL | `https://manga-nikki.tossyhal.workers.dev` |
| Wrangler target | `production` |
| 公開設定 | workers.dev有効、preview URL無効 |
| Mode vars | `APP_ENV=production`、`DATA_MODE=live`、`AI_MODE=live`、`GENERATION_ENABLED=false` |
| Public vars | `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`TURNSTILE_ALLOWED_HOSTNAMES` |
| Worker secrets | `SUPABASE_SECRET_KEY`、`TURNSTILE_SECRET_KEY` |
| Cron / Queue | `0 15 * * *`（期限削除） / なし |

Build artifactはmode/public vars、required secret names、日次Cron、Queueなしを完全一致で検査します。Cloudflare APIは既存Worker settingsとworkers.dev設定をGETし、未知binding/secretを拒否します。deploy後は7 plain-text vars、2 secrets、assets 0〜1件を確認します。Wranglerは一時`--secrets-file`を使いコードと2 secretsを1回でdeployし、自動再試行しません。Cloudflare API応答やWranglerのstdout/stderrをログ・summaryへ出しません。

有効化前にownerが[production Worker settings](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/workers/services/view/manga-nikki/production/settings)を開き、`workers.dev`以外のrouteやcustom domainがなく、Preview URLsが無効であることを確認します。これらのroute/custom domain設定はAPIで独立監査しておらず、このCDも列挙・削除しません。追加のCloudflare token scopeを要求せず、意図しない既存domainを自動削除しません。想定外のrouteやdomainがあれば、有効化前にownerが判断・対応します。

## BuildとSmoke確認

production buildはBWSから取得した公開key2件と固定Supabase URLで一時`.env.production.local`を作り、build後に必ず削除します。予期しない既存file/symlink、改行、private / 未知のpublishable形式、Turnstile公式test keyは拒否します。Build済みWorker configは上記4 mode varsと3 public vars、2 required secret names、期限削除Cron、Queueなし、routesなし、preview URL無効を検査します。

deploy前にSupabase `GET /auth/v1/settings`とread-only `get_generation_quota` RPCでkey/RPC接続を確認します。架空UUIDを渡し、Auth user・日記・jobを作成しません。deploy後はhealth `ok`、config `live` / `generationAvailable=false`、`/__deployment.json`のenvironment・SHA・`live` markerを照合します。

Bitwarden取得前のmain確認とビルドの失敗ではWorker変更はありません。deploy開始後のcancel/timeoutやsmoke失敗ではCloudflare側に新versionが反映された可能性があるため、自動rollbackは行いません。Actions run、Cloudflare管理画面のversion ID、公開marker、最新mainを照合します。rollbackはownerが別途判断して操作します。

## 有効化・停止・再実行

公開の承認後、ownerがproduction Environment variableを設定すると、次のmain pushまたは明示的なworkflow dispatchで候補になります。flagが無効でもownerがmain pushや手動実行をすると、preflight summaryへ`skipped`を記録します。flag設定だけでは配信runを開始しません。

```sh
gh variable set PRODUCTION_CONNECTED_CD_ENABLED --env production --body true --repo tossyhal/manga-nikki
gh workflow run ci.yml --ref main --repo tossyhal/manga-nikki
```

新しい配信を止めるには、production Environment variableを`false`に設定します。Environment variableを削除せず、同名のRepository / Organization variableも作成しません。既に配信したWorkerを非公開にする操作ではありません。

```sh
gh variable set PRODUCTION_CONNECTED_CD_ENABLED --env production --body false --repo tossyhal/manga-nikki
```

最新mainの配信に失敗した場合は、該当runを確認してからmainでworkflowを再実行します。古いrunの再実行はHEAD確認によりskipされます。

## 初期設定と未確認事項

Turnstile widget `manga-nikki-prod`、公開hostname、Supabase Auth側のTurnstile設定と匿名サインイン有効化はownerから準備完了の報告を受けています。10 production migrationは成功apply済み(run `42211812661`)ですが、実ブラウザ/WorkerからのAuth、CAPTCHA、二者の所有者分離、iPhone保存QAは未確認です。

実AIの費用承認は未実施で、`OPENAI_API_KEY`とQueueは設定しません。実AIを有効にする前に、生成中の画面遷移・受付状態を無通知にしない既知P2-2を修正・再確認し、budget、Queue、二重実行防止、画像保存/復旧を別承認・別検証します。
