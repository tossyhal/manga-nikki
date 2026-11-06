# Supabaseの読み取り確認（旧dev-database）

この手順はowner専用GitHub Actionsから、固定Supabase projectの接続と限られたcatalog情報だけを読み取ります。workflow、Environment、Bitwarden variableの`dev`名は旧名ですが、接続先project ref `leihsygtsamxffyybskh`は現在の唯一の意図された本番projectです。migration適用、Auth / Storage設定変更、Worker変更は行いません。レビュー済みmigrationのplan/applyは別workflowです。適用時の手順と安全境界は[DATABASE_MIGRATION.md](DATABASE_MIGRATION.md)を参照してください。

## 実行条件

- Workflowは[dev-database.yml](../.github/workflows/dev-database.yml)です。`workflow_dispatch`だけを受け付け、`main`以外のrefと`tossyhal`以外の実行者を拒否します。秘密取得前のEnvironment付きjobとCLI内の両方で実行commitが現在の`main` HEADか確認します。先行authorize jobは外部コードをcheckoutせず、repository/ref/actor/commit形式だけを確認します。
- `dev-database-setup` Environmentの許可branchは`main`だけです。ここにはBitwarden machine account token `BWS_ACCESS_TOKEN`と、Bitwarden内のDB password Secret IDを指すVariable `BWS_SUPABASE_DB_PASSWORD_SECRET_ID`を登録します。Secret IDはUUIDとして事前検証され、Bitwarden Actionへは対象DB password 1件だけを要求します。Environment設定の存在はGitHub API readbackで確認済みです。
- ownerから、専用のBitwarden project `manga-nikki-setup`とそのprojectだけを読めるmachine accountを用意したと報告を受けています。Bitwarden側のproject・machine account scopeは独立監査していません。既存staging用`BWS_ACCESS_TOKEN`やCloudflare用Secret IDを流用しないでください。
- Workflowの通常checkはlint・型検査・unit test・buildです。既存CIのPostgreSQL統合testはPRで実行されます。初期設定用jobはowner以外の実行、別repository、別ref、古いcommit、Secret ID不正でBitwarden取得前に停止します。

## 実行

GitHub CLIから最新の`main`を指定します。

```sh
gh workflow run dev-database.yml --ref main
```

runの`authorize`、`checks`、`preflight`が成功したら、ActionsのSummaryでproject ref、DB host、commit、接続・catalog読み取り結果、remote migration version、pending local migrationのfilenameとSHA-256を確認します。Summaryは実行した`main` commit内のmigration manifestを示します。現在mainには10 migrationがありますが、読み取り確認だけではapply承認になりません。main commitが変わったら最新commitでplanを取り直してください。

失敗runはSummaryまたはstep logに出る固定codeだけを共有してください。psqlの生stderr・raw response・DB password・接続URIはCLIが出力しません。`GITHUB_HEAD_STALE`なら最新`main`で再実行します。`INPUT_ACTOR_INVALID`はowner自身がActionsを開始したかを確認します。ほかの固定codeが続く場合は、そのcodeだけでownerへ知らせてください。

## 接続先とTLS

接続先は固定値で、host `aws-0-ap-northeast-1.pooler.supabase.com`、port `5432`、database `postgres`、user `postgres.leihsygtsamxffyybskh`です。passwordはworkflow入力へ貼らず、Bitwarden Actionで取得してjob内の一時環境変数としてCLIへ渡します。GitHubの永続Secretには登録しません。アプリ用Supabase URL、publishable key、secret key、OpenAI / Turnstile secretは取得しません。

[固定Supabase project](https://supabase.com/dashboard/project/leihsygtsamxffyybskh)を開き、**Connect**画面でSession Poolerの接続情報が上記host・port・database・userと一致することを確認してください。別projectや別regionが表示されたらActionsを実行せずownerへ伝えます。

PostgreSQL接続はPostgreSQL 16 clientと`verify-full`を使います。OS標準CA bundleではSupabaseの確認済み証明書chainを検証できなかったため、公開配布されているSupabase Root 2021 CAを[`supabase/certs/prod-ca-2021.crt`](../supabase/certs/prod-ca-2021.crt)へ固定しています。

- 配布元: [Supabase Root 2021 CA](https://supabase-downloads.s3.ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)
- SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`
- DER fingerprint: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`
- 有効期限: 2031-04-26 10:56:53 UTC
- 取得元・TLS hostname検証・fingerprint照合: 2026-11-06に実行環境で親担当者が確認

CLIは接続前に通常ファイルであること、SHA-256、DER fingerprint、有効期間を再検証します。Bitwarden Actionが取得したDB passwordはjob中の一時環境変数としてCLIへ渡し、GitHubへ永続Secretとして登録しません。更新時はSupabaseの公式配布元から新しいCAを別途取得し、取得元、TLS検証、SHA-256、DER fingerprint、`notBefore` / `notAfter`を独立に確認してから、証明書ファイル・固定値・この文書を同じPRで更新してください。ActionsにCAダウンロードstepを追加せず、証明書を環境変数で上書きしないでください。

## 読み取り範囲と限界

- catalog queryとmigration history queryはそれぞれ`BEGIN READ ONLY`の直後に`SET LOCAL default_transaction_read_only=on`、`statement_timeout='15s'`、`lock_timeout='5s'`、`search_path=pg_catalog`を設定し、同じtransaction内で5つの`current_setting`値を検証してから`ROLLBACK`します。これらの設定は各transaction内に限り有効で、session全体へ固定するものではありません。runnerの`PGOPTIONS`も残しますが、その反映をread-onlyの根拠にはしません。Supavisorのstartup optionsの処理には関連課題があり、実tenantのversionと反映状況は未確認です（[SupavisorのPGOPTIONS関連PR](https://github.com/supabase/supavisor/pull/768)）。
- 2026-11-06の初回run `42197768018`では、owner/ref確認、Bitwarden取得、psql SQL実行まで成功しましたが、保護条件をまとめて判定していたため`DATABASE_CATALOG_INVALID`で停止しました。どの条件が不一致だったかは記録されておらず、原因は特定できていません。修正後の接続結果は次項を参照してください。
- 修正後の読み取り専用run `42200231474`は成功し、固定Supabase projectへの接続、catalog確認、migration履歴の状態確認まで完了しました。このrunはmigration適用、Auth / Storage設定変更、Worker変更を行っていません。
- catalogではdatabase / current role / public schemaのCREATE権限、`auth.users`・`storage.objects`、必要roleの存在、public schemaのtable (`relkind=r/p`)とSupabase migration history tableの有無だけを確認します。
- migration historyがあれば別のread-only queryで`version`列だけを取得します。日記本文、Auth user、Storage object、migration名、SQL本文は読みません。remote version列がこの実行commit内のlocal version列の順序付きprefixでなければ停止します。
- historyが未作成または空でpublic tableもない場合はmigration未適用として成功し、local migrationをfilenameとSHA-256付きでpending表示します。history未作成または空なのにpublic table（unknownを含む）がある場合、remote versionがあるのに`entries` / `generations`のいずれかがない場合、unknown version・gapがある場合は停止します。履歴適用済みの状態で追加された未知のpublic tableは、この確認では検出しません。
- PostgreSQL subprocessへ渡す環境は必要なlocaleと固定PG接続項目だけです。GitHub token、Bitwarden token、他のPG設定、password file / service設定は渡しません。passwordはargv、workflow log、Summaryへ出しません。
- この確認はRLS / RPC / Auth匿名登録 / Storage policy・private設定を動作検証しません。`auth.users`と`storage.objects`は存在確認だけです。公開可能性、migration適用可否の承認、アプリ全経路の確認を意味しません。
