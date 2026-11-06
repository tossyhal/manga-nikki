# Supabase DB migrationのplanとapply

この手順は、ownerがレビュー済みのSQL migrationを固定Supabase projectへ適用するときに使います。対象project refは`leihsygtsamxffyybskh`です。現在、このprojectが唯一のSupabase本番接続先です。実AI、課金、Worker公開、Auth / Storage設定は操作しません。

## 実行条件

- Workflowは[database-migrate.yml](../.github/workflows/database-migrate.yml)です。`workflow_dispatch`だけを受け付け、repository、`main` ref、owner ID `92223710`、triggering actor `tossyhal`をcheckout前に確認します。Environment jobでも既存のread-only preflightと同じmain HEAD検査を行います。
- workflowはlint、typecheck、unit test、PostgreSQL 16の`test:db`、buildを通過してからDB接続へ進みます。実際の適用jobはEnvironment `dev-database-setup`を引き続き使い、既存のBitwarden設定からDB password 1件だけを取得します。Environmentとworkflow名にある`dev`は旧名のままですが、接続先project refは上記の固定値です。
- apply前に、最新developでレビュー済みのmigrationをmainへmergeしてください。manifestにはmain commit hashが含まれるため、mainのcommitが変わったらplanを取り直します。mainにないdevelop migrationはapply対象になりません。
- 2026-11-06にmainは`d1d74407e0c84229759433a6c551bd5442fafbe0`へ昇格し、10 migrationが統合されました。成功したread-only確認run `42200231474`はschemaを変更していません。migration applyの成功履歴はありません。

## planで内容を確認する

```sh
gh workflow run database-migrate.yml --ref main -f operation=plan
```

ActionsのSummaryでproject ref、source commit、remote migration versions、全local migrationのfilenameとSHA-256、pending migration、manifest SHA-256を確認します。planは既存のread-only preflightを実行し、Supabase CLIは起動しません。SummaryとJSON出力にSQL本文、DBの生出力、接続文字列、passwordは含みません。

manifestは、次の順序でJSON.stringifyした値のSHA-256です。JSONに空白を加えず、key順も固定します。

1. `projectRef`
2. `sourceCommit`
3. `remoteVersions`
4. `localMigrations`（version、filename、SHA-256の順）

## applyする

planのSummaryでmigration一覧をレビューし、同じmain commitで、表示されたmanifest SHA-256を入力します。

```sh
gh workflow run database-migrate.yml --ref main \
  -f operation=apply \
  -f expected_manifest=YOUR_PLAN_MANIFEST_SHA256
```

`YOUR_PLAN_MANIFEST_SHA256`をplan Summaryに表示された64桁の値へ置き換えてください。

applyはfresh read-only planのmanifestと入力値が完全一致しないと停止します。適用直前にowner/main HEAD、固定Root CAのfingerprint・有効期間、local migration filenameとcontent hashを再検証します。migrationは新しい制限付き一時workdirへコピーし、Supabase CLIが見る設定はproject IDとseed無効化だけにします。roles、seed、Vault設定、repository内の他のSupabase設定は一時workdirへ含めません。

workflowは公式Supabase CLI v2.122.0 Linux amd64 archiveをSHA-256 `59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136`で確認し、`supabase`本体と`supabase-go`だけを展開します。apply時のCLIは`db push --skip-vault --yes`に固定し、`--include-all`、`--include-roles`、`--include-seed`、reset、migration repairは行いません。password-freeの固定接続URLと、CLI subprocessに限る`PGPASSWORD`を使います。CLIのstdout/stderrは上限付きで取得して破棄し、失敗時は固定codeだけを出します。

適用後にread-only preflightを再実行し、全local migration versionがremote historyに存在してpendingが0件の場合だけ成功扱いにします。pendingがないapplyはCLIを起動しないno-opです。

## 障害時の扱い

- apply結果が不明、workflowが中断、またはpostflightが失敗した場合は同じapplyを再実行せず、Summaryの固定codeとremote migration historyをownerが調査します。自動rollback・retry・migration repairはありません。
- CLIはmigration file内の`BEGIN` / `COMMIT`を実行します。`COMMIT`後にCLIがversionをmigration ledgerへ記録する前に接続が切れたりjobが中断したりすると、schema変更だけが残りversionが未記録になる可能性があります。こうなった場合はDB状態と該当SQLを確認し、追加SQLやledgerの手編集をせず止めます。
- 共有DBへの適用後も、RLS / RPC / Auth / Storageの実運用確認が完了したことにはなりません。migration作業とアプリ結合試験は別に記録します。

## 秘密情報と適用範囲

- Environment `dev-database-setup`の`BWS_ACCESS_TOKEN`およびVariable `BWS_SUPABASE_DB_PASSWORD_SECRET_ID`は既存設定を再利用します。WorkflowからBitwardenへ要求するSecretは対象PostgreSQL password 1件だけです。Bitwarden machine accountのscopeは独立監査していません。
- workflow名、Environment名、BWS variable名はread-only DB確認から継承した旧名です。許可branchは`main`だけのままです。
- migration applyはDB schemaに対する書き込みです。レビュー済みSQLが意図した変更を除き、ad-hocのAuth設定変更、`generation_policy`有効化、予算上限引上げは行いません。実AI呼び出しやCloudflare Worker公開もこのworkflowに含めません。
