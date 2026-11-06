# Production sample CD運用

この手順はproduction Workerへ架空sampleを配信するCIだけを扱います。アプリは引き続き`APP_ENV=production`・`DATA_MODE=sample`・`AI_MODE=mock`・`GENERATION_ENABLED=false`で動きます。実日記、Supabase Auth/DB/Storage、Turnstile、AI、Queue、Cronは接続しません。

## 現在の状態

- `manga-nikki` Worker、production Environment、Bitwarden machine account、Worker用Cloudflare token、Turnstile widgetの初期設定はowner報告済みです。CloudflareとBitwardenの権限scopeは独立監査していません。
- 既存production Workerはowner報告では初期Hello Worldで、workers.devとpreview URLが無効です。CDはWorkerの存在を確認し、既存Worker以外を新規作成しません。
- `production` Environmentは`main`だけを許可します。Environment secret `BWS_ACCESS_TOKEN`はproduction用Bitwarden machine account tokenです。
- Environment variablesは`BWS_CLOUDFLARE_SECRET_ID`、`PRODUCTION_WORKER_URL`、`BWS_SUPABASE_SECRET_KEY_SECRET_ID`、`BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID`、`PRODUCTION_SAMPLE_CD_ENABLED`です。Turnstile Secret IDのEnvironment variablesもowner報告で設定済みですが、このsample CDは使用しません。
- `PRODUCTION_SAMPLE_CD_ENABLED`は`production` Environment variableです。`false`を設定し、GitHub CLIのreadbackで確認済みです。実装は値が文字列`true`の場合だけ有効で、未設定・`false`・その他の値ではskipします。
- Workflowはproduction Worker用Cloudflare token 1件だけをBitwardenから取得します。Supabase、Turnstile、AI用Secret IDは読み出しません。

## 実行条件と対象

CD jobは`database`・`check`が成功した`main`へのpush、または`main`を選んだ手動実行だけを対象にします。Repository、`github.actor_id=92223710`、`github.triggering_actor=tossyhal`、production Environmentのmain-only制限を確認します。直列化後の最初のpreflightが実行条件とSHAを検査し、Environment flagが有効でなければ成功skipして停止します。jobは`manga-nikki-deploy-production`で直列化され、pending runを最大数待機させます。

Bitwarden tokenを取得する前に、実行SHA、Repository、branch、event、actorを検証します。flagが有効な場合だけGitHub APIで現在の`main` HEADを確認し、target URLとCloudflare Secret IDのUUID形式を検証します。Supabase Secret IDはsample CDの実行条件にせず、読み出しもしません。flag無効またはSHA staleなら、success summaryへskip理由を記録し、BitwardenとCloudflareへ接続しません。ビルド後、Worker設定を読み取った後、deploy直前にも`main` HEADを確認します。古いSHAを手動再実行しても、最新HEADと一致しなければ配信しません。同一SHAの再実行は許可します。

| 項目 | 固定値 |
| --- | --- |
| Cloudflare account | `c9cee9599752cb191815c0eea6ff457e` |
| Worker | `manga-nikki` |
| 公開予定URL | `https://manga-nikki.tossyhal.workers.dev` |
| Wrangler target | `production` |
| 公開設定 | workers.dev有効、preview URL無効 |
| Worker vars | `APP_ENV=production`、`DATA_MODE=sample`、`AI_MODE=mock`、`GENERATION_ENABLED=false` |
| Cron / Queue / routes | なし |

WorkflowはCloudflare APIで固定Workerのsettingsとworkers.dev設定をGETします。既存Workerがない場合、想定外のbinding/secretがある場合、設定が不整合な場合はdeploy前に停止します。Wrangler deployはビルド成果物の固定名`manga-nikki`へ1回だけ行い、deploy自体を自動再試行しません。Cloudflare API応答やWranglerのstdout/stderrをログ・summaryへ出しません。

## BuildとSmoke確認

`.env.production.local`が存在する場合はbuild前に停止します。`pnpm build:production`はローカルの環境変数や他targetの公開値を読み込まず、公開Supabase値も与えないsample buildです。生成されたWorker configはproduction専用名、上記4つのvars、empty Cron、Queueなし、routesなし、preview URL無効を検査します。

配信後はCloudflare settingsの4つのplain-text varsとassets bindingを照合し、workers.dev有効・preview URL無効を確認します。認証tokenを付けずに公開GETし、health `ok`、config `sample` / `generationAvailable=false`、`/__deployment.json`のenvironmentとSHA一致を確認します。summaryには環境、SHA、公開予定URL、deploy/smoke状態、version ID（取得できない場合は未取得）、skip状態を記録します。

Bitwarden取得前のmain確認とビルドの失敗ではWorker変更はありません。deploy開始後のcancel/timeoutやsmoke失敗ではCloudflare側に新versionが反映された可能性があるため、自動rollbackは行いません。Actions run、Cloudflare管理画面のversion ID、公開marker、最新mainを照合します。rollbackはownerが別途判断して操作します。

## 有効化・停止・再実行

公開の承認後、ownerがproduction Environment variableを設定すると、次のmain pushまたは明示的なworkflow dispatchで候補になります。flagが無効でもownerがmain pushや手動実行をすると、preflight summaryへ`skipped`を記録します。flag設定だけでは配信runを開始しません。

```sh
gh variable set PRODUCTION_SAMPLE_CD_ENABLED --env production --body true
gh run workflow .github/workflows/ci.yml --ref main
```

新しい配信を止めるには、フラグを`false`にするか削除します。既に配信したWorkerを非公開にする操作ではありません。

```sh
gh variable set PRODUCTION_SAMPLE_CD_ENABLED --env production --body false
# または
gh variable delete PRODUCTION_SAMPLE_CD_ENABLED --env production
```

最新mainの配信に失敗した場合は、該当runを確認してからmainでworkflowを再実行します。古いrunの再実行はHEAD確認によりskipされます。

## 初期設定とsampleから先の作業

Turnstile widget `manga-nikki-prod`、公開hostname、Supabase Auth側のTurnstile設定と匿名サインイン有効化はownerから準備完了の報告を受けていますが、このアプリのsample build/CDには接続しません。production EnvironmentにあるSupabase / Turnstile Secret IDも取得せず、Supabaseへのmigration適用やAuth設定変更を行いません。sample公開の有効化は、DB接続や個人データの公開を意味しません。

アプリを実DB/Auth/Turnstileへ接続して公開する作業は別変更・別レビュー・別承認が必要です。独立レビューでは、live公開前に次のUI問題を修正・再確認する必要があると報告されています。今回のsample CDの対象ではありません。

- 匿名登録/CAPTCHA/認証待ちでまだ送信されていない状態を「処理中」「保存結果確定前」と誤表示し、画面離脱時に日記本文が失われる可能性を誤案内する。
- live 4コマの保存中に画面遷移が一度止まり、保存後に自動遷移しても生成を開始せず、説明のない下書き状態に残る。

架空sampleは一般公開されます。日記本文・本物の利用者データを入力せず、ユーザーの画像や個人情報をsample素材に追加しません。
