# 運用手順

実装・workflow・設定を正本とし、人が判断する境界と操作手順をここに残します。
秘密情報や日記本文をIssue・PR・ログ・スクリーンショットへ貼りません。

## 環境と権限

| 環境 | 用途・接続 |
|---|---|
| local-mock | 外部サービスなしの画面開発。起動は[CONTRIBUTING](../CONTRIBUTING.md) |
| local-connected | 開発用Supabase/Authと固定mock Queue。実AIは停止 |
| staging | [公開sample](https://manga-nikki-staging.tossyhal.workers.dev)。個人DB・実AI・Queue/Cronなし |
| production | [本番](https://manga-nikki.tossyhal.workers.dev)。Supabase・Turnstile・OpenAI・Queue/Cron |
| demo | 独立した検証用target。公開route追加・実利用は別承認 |

本番Supabaseは既存project `leihsygtsamxffyybskh`です。新projectの作成や接続先変更を通常の復旧手段にしません。
Workerの環境・bindingは[wrangler.jsonc](../wrangler.jsonc)、実配信時の構成は[配信実装](../src/build/production-connected-deployment.ts)も確認してください。
実AI接続・追加課金・有料化・公開範囲・継続予算の変更は別承認です。稼働中という理由だけで追加の試験生成を行いません。

JWTは署名・issuer・audience・期限・subを検証し、所有者は検証済みsubから決めます。
Supabaseの`getClaims`と`getUser`を使いますが、sign-out済みaccess tokenの即時失効は保証しません。
RLS、サーバー専用RPC、private `comics` bucketを維持し、他ownerのデータ・Storageへ直接アクセスさせません。
日記の事実にない情報を生成させず、日記内の命令・URL・HTMLを実行しません。
認証・CAPTCHA・予算制限の解除を不具合の回避策にしません。

## 設定と秘密情報

`VITE_*`はブラウザへ公開されます。公開するのはSupabase URL・publishable key・Turnstile site keyだけです。
Supabase secret key（旧service_roleを含む）、Turnstile検証用secret、OpenAI API keyはWorker専用です。
ローカルはexampleをコピーしたgitignore対象ファイルに設定し、元のexampleやGitへ値を書きません。
サーバーログには日記・脚本・プロンプト・認証情報・画像・署名URL・Storage pathを残しません。

GitHub ActionsはEnvironment別の`BWS_ACCESS_TOKEN`からBitwardenの必要項目だけを取得します。
Secret IDと公開制御はEnvironment variablesで管理し、値の配置は[各workflow](../.github/workflows)を確認してください。
`production`は配信用credential、`dev-database-setup`はDB password取得用で、権限を混ぜません。
DB操作用Environmentは名称にdevを含みますが、対象判定はscriptが固定する本番projectです。
PRのCIへ本番の秘密情報を渡さず、未信頼コードを秘密取得権限で実行しません。

本番のSecrets更新はBitwardenの承認された項目を更新し、通常CDで反映します。
[CIのproduction-connected-deploy](../.github/workflows/ci.yml)が公開値を取得してbuildし、private gateを再検査してWorker credentialを取得します。
生成infra有効時だけOpenAI keyを取得します。最終stepの`deploy-production-connected.ts`が一時Secretsファイルを作り、`wrangler deploy --secrets-file`で配信し、後始末します。
手元へSecretsをコピーしたり、値を表示する方法で確認したりしません。
漏えい時は対象credentialを失効・再発行し、Bitwarden更新と再配信後に旧keyの無効化を確認します。

## 通常の配信と確認

[CI workflow](../.github/workflows/ci.yml)の`database`・`check`成功後に配信します。

- staging：`develop`へのpushまたは同branchの手動CI、`STAGING_SAMPLE_CD_ENABLED=true`が必要です。
- production：ownerによる`main`へのpushまたは同branchの手動CIが必要です。`PRODUCTION_CONNECTED_CD_ENABLED`等のgateも通します。
- mainのMerge commitによる統合が通常経路です。手動配信もActionsの`CI`を選び、branchを`main`にして実行します。
- 古いrunの再実行で古い版を配信せず、最新mainに対して新しいrunを作ります。

production Environmentの`PRODUCTION_GENERATION_INFRA_ENABLED`はQueue/OpenAI構成、`PRODUCTION_GENERATION_ENABLED`はWorkerの生成受付を制御します。
DB policyとの両方が有効な場合だけ生成できます。設定変更後は手動CIなどの配信が必要です。
変数の許容組合せとSecret IDの必要条件は[preflight](../src/build/production-connected-preflight.ts)を正本とします。

配信後はActionsのsmoke結果、公開先の`/api/v1/health`・`/api/v1/config`・`/__deployment.json`、Cloudflareの稼働versionとbindingを確認します。本番smokeではUUIDv4由来では発行されない64文字のゼロ共有tokenへのGETで`404 NOT_FOUND`も確認し、共有routeやmigrationの未適用を検知します。
これらのread-only確認では実AIを呼びません。生成試験が必要なら追加承認と費用範囲を先に確認します。
画面で認証・保存・再読込・削除を確認する場合も実日記を使わず、他owner拒否やCAPTCHA等の確認と区別して記録します。
`pnpm build:staging`・`build:production`・`build:demo`はローカル成果物だけで、配信操作ではありません。

## DB変更

[supabase/migrations](../supabase/migrations)をレビューし、隔離`pnpm test:db`を通してからowner専用[Supabase DB migration](../.github/workflows/database-migrate.yml)を使います。
通常CDはschema migrationを適用しません。Workerとの互換性と適用順をPRで確認してください。

1. Actionsで`Supabase DB migration`、branch `main`、`operation=plan`を新規実行します。
2. plan結果の接続先、既存履歴、pending SQL、manifest SHA-256を確認します。pendingがなければapplyしません。
3. 同じレビュー対象の最新mainで`operation=apply`を新規実行し、`expected_manifest`に確認済みhashを入力します。
4. 履歴の照合結果と適用後のplanを確認します。mainや対象SQLが変わった場合はplanからやり直します。

owner・最新main・manifestを秘密取得前と適用前に検査します。applyのrun再実行は拒否されます。
中断・失敗時はDB履歴と実状態を読み取り、原因を調べて新しいplanへ進みます。無条件に再適用しません。
固定Supabase CLI、対象の許容履歴、SQLの検査は[runner](../src/build/database-migration-runner.ts)を参照してください。
テストbootstrapを本番へ流さず、DDLのためにWorkerのservice roleを昇格させません。

Queue・private bucket・Storage deny policyはschema migrationとは別です。
[本番生成resource初期設定](../.github/workflows/production-generation-setup.yml)の`check`が読取り検査、`setup`が初期資源作成、`probe-storage`が拒否試験、`setup-storage-policies`が不足policy作成です。
後者3操作は既存資源の状況と承認を確認し、`confirmation=manga-nikki-generations-production`を指定します。
中断時は状態を調べ、作成操作を無条件に再実行しません。

## 生成枠・停止・再開

生成枠はDBトランザクションで原子的に予約し、モデル・単価・owner・残り回数をブラウザから信用しません。
既存public80 policyは累積80USDのDB予約上限と、通常匿名アカウント3回/JST日です。
owner初回試験アカウントだけ日次例外があります。任意のユーザーに例外を広げません。
固定1USD/漫画を予約する方式であり、記帳額は実費とは異なります。
**80USDはプロバイダ請求の厳密なhard capではありません。**実料金、権限、provider側制限と使用量を別途確認します。

緊急停止はownerがActionsの[初回漫画生成試験のDBpolicy](../.github/workflows/production-generation-trial-policy.yml)をbranch `main`で新規実行し、次を指定します。

- `operation=stop`
- `confirmation=STOP_GENERATION`
- `provider_cost_verified=false`

`check`で停止状態を確認します。必要に応じてproductionの`PRODUCTION_GENERATION_ENABLED=false`に変更し、最新mainのCIで再配信します。
異常課金・漏えい時はprovider key自体の停止・失効も検討します。既に送信済みの呼出しや請求は停止で取り消せません。

同workflowの`prepare`・`enable`は初回1漫画試験用です。公開80USD設定を停止した後、`enable`で同じ公開設定を再開することはできません。
`activate-public80`は使用済み初回試験状態からの一回限りの移行で、再開用操作ではありません。
`activate-event250`は、稼働中の固定public80 policyからownerが一度だけ切り替える操作です。`global_total_limit=250`、内部予約budget 250,000,000 micro USD、通常owner/JST日3回を設定し、ownerデバッグ例外とprofileを保ちます。既存利用も全期間250件に含み、counter・履歴・reserved/held reservation・unknown attemptを変更しません。1件あたりの固定予約上限1,000,000 micro USDも維持します。public80停止中やevent250適用後（停止中を含む）は拒否し、event250の再開操作は用意しません。

このbudgetはDB内の予約上限で、実請求のhard capではありません。100 USDクレジット・自動チャージOFFの条件でも、provider側の請求・反映遅延を含め100 USD以内を保証しません。費用条件を確認し、workflowで`operation=activate-event250`、`confirmation=ACTIVATE_EVENT_250_3_PER_JST_DAY_AFTER_VERIFIED_COST`、`provider_cost_verified=true`を明示します。mergeや通常CDはDB policyを変更しません。

再開時は現DB状態、保持予約、承認済み費用と回数を確認し、レビューされた専用変更を用意します。
確認文字列を変えたり、counterを初期化したりして既存guardを迂回しません。
policy操作の詳細条件は[production-trial-policy実装](../src/build/production-trial-policy.ts)を参照してください。

本番Queueの`max_batch_size=1`・`max_retries=3`は維持し、consumerの`max_concurrency`を10にします。初回の滞留を減らすための初期値で、OpenAIのIPM上限を厳密に制御せず、実AIでの速度や80人同時時の完了時間も保証しません。実AIを使った負荷測定は別承認です。

Queueの重複配信はclaim・attempt台帳で制御します。
外部AIの実行・課金が不明な`unknown`は自動再実行せず、`held`として予約を保持します。
provider request IDと管理画面の記録から実行有無を調査し、外部未送信を証明できない枠を返却しません。
日記削除や停止後に戻ったprovider応答も台帳で確定し、削除済み日記を復活させません。

`20261107030000_parallel_image_attempts.sql`適用後は、人物参照用の1コマ目が完成してから2〜4コマ目を並列に生成します。3件の試行をDBで一括記録し、全応答の記帳を待ってから保存・失敗を判定します。モデル・画質・最大4回の画像呼出し・予約予算は変更しません。migration適用前は従来の直列生成を維持します。実AIを使う速度測定は別承認です。

## 漫画のURL共有

`20261107020000_comic_shares.sql`適用後、所有者の明示操作で選択した生成済み漫画だけに共有URLを発行します。公開APIは漫画の画像・タイトル・セリフ・説明文と最大60秒の画像署名URLだけを返し、日記本文・内部の画像描画指示（scene）・owner・Storage pathは返しません。公開用のsceneは表示済みのcaptionまたはコマ番号へ置換します。共有URLは閲覧権限そのものなのでログ・分析サービス・第三者へ不用意に渡しません。共有解除ボタンはなく、日記の削除・30日の保存期限で新しい閲覧を停止します。既に取得された画像や発行済み署名URLは回収できません。

private bucketと既存RLSは変更しません。共有テーブルはprivate schema内に置き、作成・読取りRPCはWorkerのservice role専用です。新しい環境変数は不要です。公開前にmigrationを適用し、架空データで別ブラウザからの閲覧・本文非公開・削除後の失効を確認してください。ローカルモックの共有情報はメモリ内だけにあり、開発サーバー再起動で失われます。

## 障害復旧とデータ削除

生成済み画像の保存復旧は既存Storageと保存taskから再開し、AIを呼び直しません。
Queue/Cronの状態、DB job・attempt・予約、保存taskを読み取り、保存障害とprovider結果不明を分けて調査します。
再生成や手動台帳変更で障害を隠しません。Cron・cleanupの実装は[src/server/scheduled-handler.ts](../src/server/scheduled-handler.ts)を参照してください。

Workerの不具合は、正常だったversion IDをCloudflareのdeployment履歴で特定します。
その版と現在DBの互換性、Secrets、Queue consumer/binding、Cronの設定を確認し、必要なら先に生成を止めます。
承認された正常versionへ切り戻してhealth/config/markerを確認し、修正版を通常PR/CDで配信します。
確認なしの`--force`や旧workflowの再実行で切り戻しません。DBは逆migration・resetで巻き戻さず、互換な修正migrationで復旧します。

削除操作・30日保存期限では、閲覧と新しい署名URLの発行を先に止めます。物理消去は非同期です。
日次Cronがactive job・保存leaseを確認し、Storageの削除と不在確認後にDBを回収します。
Storage障害や処理上限で翌日以降へ残る場合があり、30日以内の物理消去を保証するものではありません。
削除outboxは遅延uploadを再照合するため自動retentionを持ちません。全upload producer停止確認前にmarkerを消しません。
発行済み署名URLの最大60秒の残存、外部AI側の保持、DBバックアップは別の制約です。

**バックアップと復元手順は未整備です。**復旧できると仮定せず、利用プランの保持・復元条件と実際のバックアップを確認してください。
DB/Storageの手動削除やproject停止は承認を得てから行います。停止前に残存job、unknown/held、画像と削除outboxを確認します。
終了後も公開を続ける場合は予算・正式認証・保存期間を改めて合意し、実日記をGitや宣伝素材へ転用しません。
