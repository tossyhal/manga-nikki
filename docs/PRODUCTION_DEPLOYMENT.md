# Production connected CD運用

この手順は既存production Workerへ日記CRUDと漫画生成基盤を配信するowner限定CIを扱います。productionは`APP_ENV=production`・`DATA_MODE=live`・`AI_MODE=live`で動きます。生成は配信時の`GENERATION_ENABLED`とDB policyの両方が有効な場合に限ります。生成停止後も日記と保存済み漫画の閲覧は継続できます。

## 現在の状態

- `manga-nikki` Worker、production Environment、Bitwarden machine account、Worker用Cloudflare token、Turnstile widgetの初期設定はowner報告済みです。CloudflareとBitwardenの権限scopeは独立監査していません。
- 2026-11-06に初回接続版を公開しました。source `0ba2dc3057fbf1d3028188e000ec1f6a9bbb9c5e`の[Actions run 42220799768](https://github.com/tossyhal/manga-nikki/actions/runs/42220799768)はattempt 2で成功しました。agent-browserからのGETでhealth `200/ok`、config `200/live/generationAvailable=false`、deployment marker `200/production`と同SHAを確認し、deploy後のWorker bindings/secretsとread-only Supabase probeも成功しています。現在の公開SHAはWorkerの`/__deployment.json` markerで確認できます。CDは既存Worker以外を作成しません。
- `production` Environmentは`main`だけを許可します。Environment secret `BWS_ACCESS_TOKEN`はproduction用Bitwarden machine account tokenです。
- 2026-11-06のGitHub API readbackで、activeなruleset `main-owner-merge-only`（ID `26636985`）は`refs/heads/main`への更新を制限し、User ID `92223710`だけが`pull_request`経由でbypassできます。activeな`protect-main`（ID `25877767`）はPRとmerge commitを必須にし、force pushと削除を禁止、bypassなしです。mainとworkflowの変更はownerによるPR mergeが必要で、他collaboratorの直接更新・mergeはできません。
- Environment variablesは`BWS_CLOUDFLARE_SECRET_ID`、`BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID`、`BWS_SUPABASE_SECRET_KEY_SECRET_ID`、`BWS_TURNSTILE_SITE_KEY_SECRET_ID`、`BWS_TURNSTILE_SECRET_KEY_SECRET_ID`、`BWS_OPENAI_API_KEY_SECRET_ID`、`PRODUCTION_WORKER_URL`、`PRODUCTION_CONNECTED_CD_ENABLED`、`PRODUCTION_GENERATION_INFRA_ENABLED`、`PRODUCTION_GENERATION_ENABLED`、`PRODUCTION_GENERATION_ALLOWED_OWNER_ID`です。
- `PRODUCTION_CONNECTED_CD_ENABLED=true`です。flagが`true`でない場合は成功skipし、BWS / Cloudflareへ接続しません。旧`PRODUCTION_SAMPLE_CD_ENABLED`を参照せずsample fallbackもしません。
- Build前は公開用publishable key/site keyの2件だけを取得します。build後にmain gateを再確認してからCloudflare tokenとWorker secretsを取得します。生成基盤ONではOpenAI keyも読み取り、owner gateの値を含む4つのWorker secretsをまとめて配信します。基盤OFFでは従来の2 secretsだけです。
- 同名のRepository / Organization variableは作成しません。Environment variableを削除すると下位scopeの同名variableが使われる可能性があるため、停止時も削除せず`false`を設定します。

## 実行条件と対象

CD jobは`database`・`check`が成功した`main`へのpush、または`main`を選んだ手動実行だけを対象にします。checkout後にmiseで固定Node.js `24.22.1`とpnpmを設定してから、Repository、`github.actor_id=92223710`、`github.triggering_actor=tossyhal`、production Environmentのmain-only制限を確認します。直列化後のpreflightがSHAを検査し、Environment flagが有効でなければ成功skipして停止します。無効時もcheckoutとmiseのruntime setupは行いますが、GitHub APIでのmain HEAD照会、`pnpm install`、build、Bitwarden、Cloudflareには進みません。jobは`manga-nikki-deploy-production`で直列化され、pending runを最大数待機させます。

最初のgateは固定Node準備後に実行し、flag、実行SHA、Repository、main、actor、固定Worker URL、Secret ID形式（基盤OFFは5件、ONはOpenAIを含む6件）を確認します。無効flagではGitHub API main照会、package install、BWS、Cloudflareへ進みません。有効時は公開key2件でbuildし、private credential取得前にgateを再実行します。deploy scriptはさらに最新mainを確認し、Cloudflare settingsとSupabase probe後にもう一度mainを確認してからdeployします。

| 項目 | 固定値 |
| --- | --- |
| Cloudflare account | `c9cee9599752cb191815c0eea6ff457e` |
| Worker | `manga-nikki` |
| 公開URL | `https://manga-nikki.tossyhal.workers.dev` |
| Wrangler target | `production` |
| 公開設定 | workers.dev有効、preview URL無効 |
| Mode vars | `APP_ENV=production`、`DATA_MODE=live`、`AI_MODE=live`、`GENERATION_ENABLED`は配信時のflag値 |
| Public vars | `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`TURNSTILE_ALLOWED_HOSTNAMES` |
| Worker secrets（基盤ON） | `SUPABASE_SECRET_KEY`、`TURNSTILE_SECRET_KEY`、`OPENAI_API_KEY`、`GENERATION_ALLOWED_OWNER_ID` |
| Cron / Queue（基盤ON） | `0 15 * * *`（期限削除）、`* * * * *`（生成復旧） / `manga-nikki-generations-production` |

Build artifactは選択したprofileのmode/public vars、required secret names、Cron、Queueを完全一致で検査します。Cloudflare APIは既存Worker settingsとworkers.dev設定をGETし、未知binding/secretを拒否します。基盤ONのdeploy後は7 plain-text vars、4 secrets、専用Queue、assets 0〜1件を確認します。Wranglerは一時`--secrets-file`を使いコードとsecretsを1回でdeployし、自動再試行しません。Cloudflare API応答やWranglerのstdout/stderrをログ・summaryへ出しません。

owner報告では初回公開前に[production Worker settings](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/workers/services/view/manga-nikki/production/settings)を開き、`workers.dev`以外のrouteやcustom domainがなく、Preview URLsが無効であることを確認済みです。これらのroute/custom domain設定はCloudflare APIで独立監査しておらず、このCDも列挙・削除しません。追加のCloudflare token scopeを要求せず、意図しない既存domainを自動削除しません。想定外のrouteやdomainがあれば、ownerが判断・対応します。

## BuildとSmoke確認

production buildはBWSから取得した公開key2件と固定Supabase URLで一時`.env.production.local`を作り、build後に必ず削除します。予期しない既存file/symlink、改行、private / 未知のpublishable形式、Turnstile公式test keyは拒否します。Build済みWorker configは上記4 mode varsと3 public vars、profileに対応するsecret names・Cron・Queue、routesなし、preview URL無効を検査します。

deploy前にSupabase `GET /auth/v1/settings`とread-only `get_generation_quota` RPCでkey/RPC接続を確認します。架空UUIDを渡し、Auth user・日記・jobを作成しません。deploy後はhealth `ok`、config `live`、`/__deployment.json`のenvironment・SHA・`live` markerを照合します。生成flagがfalseなら`generationAvailable=false`を要求し、trueの場合はDB緊急停止を妨げないようbooleanを検査します。

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

Turnstile widget `manga-nikki-prod`、公開hostname、Supabase Auth側のTurnstile設定と匿名サインイン有効化はownerから準備完了の報告を受けています。10 production migrationは成功apply済み(run `42211812661`)です。deploy後のWorker bindings/secrets、read-only Supabase probe、health/config/deployment markerの確認は成功しました。実Cronの実行結果、別匿名ユーザーによる日記所有者分離QA、CAPTCHA失効・再利用拒否ケースは未確認です。ownerはiPhone Safariとホーム画面PWAで日記保存・再起動後の保持・削除を確認しました。

2026-11-06 UTCにownerがOpenAIの初回試験を全体最大1漫画、自動再試行なしで承認し、厳密な実請求停止を保証できない費用条件も追認しました。試験用配信[42239099146](https://github.com/tossyhal/manga-nikki/actions/runs/42239099146)は成功し、ownerから「4コマ表示・再読み込みOK」の報告を受けました。実AI生成・private Storage保存・再読み込みは確認済みです。実費、追加生成の予算と公開範囲は未確定で、追加生成は承認していません。100USDのAPIクレジットはowner報告であり、承認予算の増額ではありません。

## 生成基盤の段階設定

production Environmentの`PRODUCTION_GENERATION_INFRA_ENABLED`と`PRODUCTION_GENERATION_ENABLED`は初期値`false`です。前者だけを`true`にすると、専用Queue `manga-nikki-generations-production`、復旧Cron、`OPENAI_API_KEY`と`GENERATION_ALLOWED_OWNER_ID`を追加した版を配信します。後者とDB policyが両方有効になるまで実AI生成は始まりません。試験の`PRODUCTION_GENERATION_ALLOWED_OWNER_ID`は`all`です。OpenAI keyは`BWS_OPENAI_API_KEY_SECRET_ID`からbuild後だけ取得します。

- `openai-readiness.yml`はmainのowner限定手動実行です。固定2モデルの情報をGETするだけで課金生成は行いません。成功しても生成権限、組織認証、残高を保証しません。
- `production-generation-setup.yml`の`check`はQueue・Storage・DB権限を読み取ります。`setup`は不足する専用Queueと非公開`comics` bucketだけを作成し、既存設定の不一致では停止します。
- `setup-storage-policies`は不足する固定2件のrestrictive deny policyだけを作成します。`probe-storage`は架空PNGと一時利用者で直接アクセス拒否を確認して片付けます。書込操作のconfirmationは`manga-nikki-generations-production`です。中断・失敗時は結果を調査し、自動で再試行しません。
- Worker限定tokenでQueue作成が拒否された場合、ownerが[Queues](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/queues)で上記の名前を作成します。Worker権限を全Workerへ広げません。通常CDではaccount-owned tokenの別policyへ、Workers Editorをmanga-nikkiだけ、Queues Writeを対象accountに設定します。プロフィール側のQueues専用tokenをWorker用tokenへ置き換えるとWorker配信は拒否されます。

生成基盤の配信前にQueue・Storage拒否試験を完了し、生成ON前にDBの全体枠1、総予算1,000,000 micro USD以下、使用済みcounter、固定profileと最大費用を確認します。予約上限はOpenAI側の請求を強制停止する機能ではありません。通常の公開拡張では最大費用の根拠を確認します。今回の単発試験は、厳密な実請求停止を保証できないことをownerが理解して追認した例外として区別します。

試験枠の操作はmainのowner限定`production-generation-trial-policy.yml`で行います。`check`は読取のみ、`prepare`は`PREPARE_ONE_COMIC_1USD_TRIAL`を確認文字列に指定し、生成停止を維持して日次・全期間1漫画、総予算・予約額各1USDの固定profileを設定します。既存counter行または生成履歴があれば停止し、削除やresetはしません。`enable`は`ENABLE_ONE_COMIC_1USD_TRIAL_AFTER_VERIFIED_COST`と`provider_cost_verified=true`が必要で、費用の根拠確認前に実行しません。`stop`は`STOP_GENERATION`を指定し、policyのenabledだけをfalseにします。既存予約やunknownの枠は維持します。

基盤を追加した後の生成停止はDB policyをfalseにし、必要なら`PRODUCTION_GENERATION_ENABLED=false`で再配信します。Queue/Secretsが残るため`PRODUCTION_GENERATION_INFRA_ENABLED`はtrueを維持します。基盤なし版への切替は通常停止とは別の削除計画が必要です。


## Storage policyの正式委任

`supautils.policy_grants`が`postgres`へ`storage.buckets`と`storage.objects`の両方を委任している場合は、owner membershipや`SET ROLE`がなくても固定restrictive policyを作成できます。metadataと実行直前のSQLは、登録済みGUCが`context=sighup`・`vartype=string`であることと、JSON内の固定2tableを照合します。委任設定自体やGRANT、table owner、RLSは変更しません。設定がない場合は既存のowner/SET ROLE経路だけを許可し、既存policy不一致は上書きせず停止します。

一次資料は[Supabaseの既定設定](https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2)、[supautilsのpolicy委任仕様](https://github.com/supabase/supautils#table-ownership-bypass)、[GUC登録](https://github.com/supabase/supautils/blob/master/src/supautils.c)です。`current_setting('supautils.policy_grants',true)`は読取専用で確認でき、設定変更やowner roleの追加は不要です。

`supabase/tests/production_platform_delegation.sql`は、固定2tableを委任したsupautils付きの廃棄可能PostgreSQL専用fixtureです。非superuserかつownerのUSAGE/SETなしでの作成、既存policy保持、不一致時のtransaction rollback、RLS維持を確認します。

## 初回試験直前の検証記録（2026-11-06 UTC）

- [42237568661](https://github.com/tossyhal/manga-nikki/actions/runs/42237568661)で、同じaccount-owned tokenによるQueue・Workerの読取、private Storage設定、固定restrictive policyのmetadata検査が成功しました。tokenはWorkers Editorをmanga-nikkiだけ、Queues Writeを対象accountに限定しています。旧tokenは新CDの検証前に失効させません。
- [42234891276](https://github.com/tossyhal/manga-nikki/actions/runs/42234891276)では、Storageの一時Auth利用者2人・架空PNGによる直接読取/署名/書込拒否とcleanupが成功しました。このrun全体は当時のQueue権限不足で失敗しており、全成功とは扱いません。後続の上記runでQueue権限を確認済みです。
- [42235181419](https://github.com/tossyhal/manga-nikki/actions/runs/42235181419)のreadbackはenabled=false、trialPrepared=true、historyEmpty=true、policyTriggerPresent=trueです。[42237804661](https://github.com/tossyhal/manga-nikki/actions/runs/42237804661)ではsource 0572d938a679ec3afdc5e78eebbf5973943bae58を、生成OFFのままQueue・OpenAI key・Cron付きで配信し、検査が成功しました。
- ownerはiPhoneのホーム画面PWAで、架空日記の保存・再起動後の保持・削除の成功を報告しました。続く試験用配信後に実AIの4コマ表示・再読み込みの成功も報告しました。別匿名ユーザーによる日記所有者分離、実CAPTCHA失効/再利用拒否、実Cron実行結果、モデル品質の詳細評価・実費は未検証です。
- ownerは実請求を厳密に1USDで停止できない条件を確認し、架空日記1件だけの試験を追認しました。`provider_cost_verified`はこの試験の費用条件を確認・承認した操作入力であり、厳密なprovider請求capの証明ではありません。承認内容は`docs/OPERATIONS.md`に記録します。
