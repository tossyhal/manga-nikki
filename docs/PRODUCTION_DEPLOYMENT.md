# Production connected CD運用

この手順は既存production Workerへ日記CRUD接続版を配信するowner限定CIを扱います。productionは`APP_ENV=production`・`DATA_MODE=live`・`AI_MODE=live`・`GENERATION_ENABLED=false`で動きます。実AIは停止し、Queue bindingとOpenAI keyは設定しません。

## 現在の状態

- `manga-nikki` Worker、production Environment、Bitwarden machine account、Worker用Cloudflare token、Turnstile widgetの初期設定はowner報告済みです。CloudflareとBitwardenの権限scopeは独立監査していません。
- 2026-11-06に初回接続版を公開しました。source `0ba2dc3057fbf1d3028188e000ec1f6a9bbb9c5e`の[Actions run 42220799768](https://github.com/tossyhal/manga-nikki/actions/runs/42220799768)はattempt 2で成功しました。agent-browserからのGETでhealth `200/ok`、config `200/live/generationAvailable=false`、deployment marker `200/production`と同SHAを確認し、deploy後のWorker bindings/secretsとread-only Supabase probeも成功しています。現在の公開SHAはWorkerの`/__deployment.json` markerで確認できます。CDは既存Worker以外を作成しません。
- `production` Environmentは`main`だけを許可します。Environment secret `BWS_ACCESS_TOKEN`はproduction用Bitwarden machine account tokenです。
- 2026-11-06のGitHub API readbackで、activeなruleset `main-owner-merge-only`（ID `26636985`）は`refs/heads/main`への更新を制限し、User ID `92223710`だけが`pull_request`経由でbypassできます。activeな`protect-main`（ID `25877767`）はPRとmerge commitを必須にし、force pushと削除を禁止、bypassなしです。mainとworkflowの変更はownerによるPR mergeが必要で、他collaboratorの直接更新・mergeはできません。
- Environment variablesは`BWS_CLOUDFLARE_SECRET_ID`、`BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID`、`BWS_SUPABASE_SECRET_KEY_SECRET_ID`、`BWS_TURNSTILE_SITE_KEY_SECRET_ID`、`BWS_TURNSTILE_SECRET_KEY_SECRET_ID`、`PRODUCTION_WORKER_URL`、`PRODUCTION_CONNECTED_CD_ENABLED`です。
- `PRODUCTION_CONNECTED_CD_ENABLED=true`です。flagが`true`でない場合は成功skipし、BWS / Cloudflareへ接続しません。旧`PRODUCTION_SAMPLE_CD_ENABLED`を参照せずsample fallbackもしません。
- Build前は公開用publishable key/site keyの2件だけを取得します。build後にmain gateを再確認してから、Cloudflare tokenと2つのWorker secretを取得します。AI用secretは読み出しません。
- 同名のRepository / Organization variableは作成しません。Environment variableを削除すると下位scopeの同名variableが使われる可能性があるため、停止時も削除せず`false`を設定します。

## 実行条件と対象

CD jobは`database`・`check`が成功した`main`へのpush、または`main`を選んだ手動実行だけを対象にします。checkout後にmiseで固定Node.js `24.22.1`とpnpmを設定してから、Repository、`github.actor_id=92223710`、`github.triggering_actor=tossyhal`、production Environmentのmain-only制限を確認します。直列化後のpreflightがSHAを検査し、Environment flagが有効でなければ成功skipして停止します。無効時もcheckoutとmiseのruntime setupは行いますが、GitHub APIでのmain HEAD照会、`pnpm install`、build、Bitwarden、Cloudflareには進みません。jobは`manga-nikki-deploy-production`で直列化され、pending runを最大数待機させます。

最初のgateは固定Node準備後に実行し、flag、実行SHA、Repository、main、actor、固定Worker URL、5つのSecret ID形式を確認します。無効flagではGitHub API main照会、package install、BWS、Cloudflareへ進みません。有効時は公開key2件でbuildし、private credential取得前にgateを再実行します。deploy scriptはさらに最新mainを確認し、Cloudflare settingsとSupabase probe後にもう一度mainを確認してからdeployします。

| 項目 | 固定値 |
| --- | --- |
| Cloudflare account | `c9cee9599752cb191815c0eea6ff457e` |
| Worker | `manga-nikki` |
| 公開URL | `https://manga-nikki.tossyhal.workers.dev` |
| Wrangler target | `production` |
| 公開設定 | workers.dev有効、preview URL無効 |
| Mode vars | `APP_ENV=production`、`DATA_MODE=live`、`AI_MODE=live`、`GENERATION_ENABLED=false` |
| Public vars | `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`TURNSTILE_ALLOWED_HOSTNAMES` |
| Worker secrets | `SUPABASE_SECRET_KEY`、`TURNSTILE_SECRET_KEY` |
| Cron / Queue | `0 15 * * *`（期限削除） / なし |

Build artifactはmode/public vars、required secret names、日次Cron、Queueなしを完全一致で検査します。Cloudflare APIは既存Worker settingsとworkers.dev設定をGETし、未知binding/secretを拒否します。deploy後は7 plain-text vars、2 secrets、assets 0〜1件を確認します。Wranglerは一時`--secrets-file`を使いコードと2 secretsを1回でdeployし、自動再試行しません。Cloudflare API応答やWranglerのstdout/stderrをログ・summaryへ出しません。

owner報告では初回公開前に[production Worker settings](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/workers/services/view/manga-nikki/production/settings)を開き、`workers.dev`以外のrouteやcustom domainがなく、Preview URLsが無効であることを確認済みです。これらのroute/custom domain設定はCloudflare APIで独立監査しておらず、このCDも列挙・削除しません。追加のCloudflare token scopeを要求せず、意図しない既存domainを自動削除しません。想定外のrouteやdomainがあれば、ownerが判断・対応します。

## BuildとSmoke確認

production buildはBWSから取得した公開key2件と固定Supabase URLで一時`.env.production.local`を作り、build後に必ず削除します。予期しない既存file/symlink、改行、private / 未知のpublishable形式、Turnstile公式test keyは拒否します。Build済みWorker configは上記4 mode varsと3 public vars、2 required secret names、期限削除Cron、Queueなし、routesなし、preview URL無効を検査します。

deploy前にSupabase `GET /auth/v1/settings`とread-only `get_generation_quota` RPCでkey/RPC接続を確認します。架空UUIDを渡し、Auth user・日記・jobを作成しません。deploy後はhealth `ok`、config `live` / `generationAvailable=false`、`/__deployment.json`のenvironment・SHA・`live` markerを照合します。

Bitwarden取得前のmain確認とビルドの失敗ではWorker変更はありません。deploy開始後のcancel/timeoutやsmoke失敗ではCloudflare側に新versionが反映された可能性があるため、自動rollbackは行いません。Actions run、Cloudflare管理画面のversion ID、公開marker、最新mainを照合します。rollbackはownerが別途判断して操作します。

## 有効化・停止・再実行

初回公開は2026-11-06に完了し、Environment flagは`true`です。flagが有効な間はCIに成功したmain pushでも自動配信します。flag変更だけでは配信runは開始しません。成功したsource SHAとrunは上記「現在の状態」に記録しています。flagが無効でもownerがmain pushや手動実行をすると、preflight summaryへ`skipped`を記録します。

新しい配信を止めるには、production Environment variableを`false`に設定します。Environment variableを削除せず、同名のRepository / Organization variableも作成しません。既に配信したWorkerを非公開にする操作ではありません。

```sh
gh variable set PRODUCTION_CONNECTED_CD_ENABLED --env production --body false --repo tossyhal/manga-nikki
```

停止後に配信を再開する場合も、先にWorker settingsでroute・custom domain・Preview URLsを確認し、flagを`true`にしてからmain workflowを明示的に実行します。

```sh
gh variable set PRODUCTION_CONNECTED_CD_ENABLED --env production --body true --repo tossyhal/manga-nikki
gh workflow run ci.yml --ref main --repo tossyhal/manga-nikki
```

最新mainの配信に失敗した場合は、該当runを確認してからmainでworkflowを再実行します。古いrunの再実行はHEAD確認によりskipされます。

## 初期設定と未確認事項

Turnstile widget `manga-nikki-prod`、公開hostname、Supabase Auth側のTurnstile設定と匿名サインイン有効化はownerから準備完了の報告を受けています。10 production migrationは成功apply済み(run `42211812661`)です。deploy後のWorker bindings/secrets、read-only Supabase probe、health/config/deployment markerの実ブラウザ確認は成功しました。実Cronの実行結果、別匿名ユーザーによる所有者分離QA、CAPTCHA失効・再利用拒否ケース、PWAホーム追加は未確認です。owner報告ではTurnstile操作後にiPhone Safariからの日記保存・再読み込み・削除を確認済みです。agent-browserによる確認は手動CAPTCHAが表示された時点でキャンセルしました。

2026-11-06にownerがOpenAIの初回試験を総額1USD、全体最大1漫画、自動再試行なしで承認しました。UUID限定は行わず、試験中の受付は全体枠で制限します。100USDのAPIクレジットはowner報告であり、承認予算の増額ではありません。一般向け生成の有効化は未承認です。画面遷移後の受付状態通知は実装・ローカル検証済みですが、実AI・実費・実Storage/Queueは未検証です。

## 生成基盤の段階設定

production Environmentの`PRODUCTION_GENERATION_INFRA_ENABLED`と`PRODUCTION_GENERATION_ENABLED`は初期値`false`です。前者だけを`true`にすると、専用Queue `manga-nikki-generations-production`、復旧Cron、`OPENAI_API_KEY`と`GENERATION_ALLOWED_OWNER_ID`を追加した版を配信します。後者とDB policyが両方有効になるまで実AI生成は始まりません。試験の`PRODUCTION_GENERATION_ALLOWED_OWNER_ID`は`all`です。OpenAI keyは`BWS_OPENAI_API_KEY_SECRET_ID`からbuild後だけ取得します。

- `openai-readiness.yml`はmainのowner限定手動実行です。固定2モデルの情報をGETするだけで課金生成は行いません。成功しても生成権限、組織認証、残高を保証しません。
- `production-generation-setup.yml`の`check`はQueue・Storage・DB権限を読み取ります。`setup`は不足する専用Queueと非公開`comics` bucketだけを作成し、既存設定の不一致では停止します。
- `setup-storage-policies`は不足する固定2件のrestrictive deny policyだけを作成します。`probe-storage`は架空PNGと一時利用者で直接アクセス拒否を確認して片付けます。書込操作のconfirmationは`manga-nikki-generations-production`です。中断・失敗時は結果を調査し、自動で再試行しません。
- Worker限定tokenでQueue作成が拒否された場合、ownerが[Queues](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/queues)で上記の名前を作成します。追加のアカウント全体tokenは要求しません。

生成基盤の配信前にQueue・Storage拒否試験を完了し、生成ON前にDBの全体枠1、総予算1,000,000 micro USD以下、使用済みcounter、固定profileと最大費用を確認します。予約上限はOpenAI側の請求を強制停止する機能ではありません。最大費用の根拠が確認できるまで課金試験は行いません。

基盤を追加した後の生成停止はDB policyをfalseにし、必要なら`PRODUCTION_GENERATION_ENABLED=false`で再配信します。Queue/Secretsが残るため`PRODUCTION_GENERATION_INFRA_ENABLED`はtrueを維持します。基盤なし版への切替は通常停止とは別の削除計画が必要です。
