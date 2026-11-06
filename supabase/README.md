# SupabaseのDBコードと検査

DBのschema・権限・RPCの正本は[migrations](migrations)です。
共有DBへ適用する前に隔離DBで検査し、[運用手順](../docs/OPERATIONS.md)のowner専用workflowを使います。

## 隔離PostgreSQLテスト

PostgreSQL 16のサーバー・クライアント（`initdb`、`pg_ctl`、`psql`）を用意し、通常ユーザーで実行します。
Node.jsとpnpmはリポジトリのmise設定を使います。

```sh
pnpm test:db
```

バイナリは`pg_config --bindir`から探します。見つからない場合は指定してください。

```sh
PG_BIN=/usr/lib/postgresql/16/bin pnpm test:db
```

Windows PowerShellでは`$env:PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'`と設定できますが、Windows実機は未検証です。
rootで実行せず、既存DBへ接続するための資格情報も渡しません。

[テストrunner](../scripts/test-db.mjs)は一時ディレクトリへ空のクラスタを作り、空きlocalhost TCPポートで起動します。
一時的なランダムパスワードとSCRAM-SHA-256を使用し、既存の接続先を示す`PG*`環境変数は利用しません。
終了・中断時には作成したクラスタだけを停止・削除します。

## コードの入口

| 場所 | 確認する内容 |
|---|---|
| [migrations](migrations) | テーブル、RLS、サーバー専用RPC、予約・attempt・保存・削除台帳 |
| [tests](tests) | 日記CRUD、所有者分離、予約競合、生成・保存・削除、運用policyの回帰テスト |
| [tests/bootstrap.sql](tests/bootstrap.sql) | 隔離テスト専用のrole・Auth等の最小schema |
| [storage/comics-bucket.sql](storage/comics-bucket.sql) | private画像bucketとStorageの拒否policy |
| [../src/server](../src/server) | JWT検証、RPC呼出し、Storage・Queue・Cronの利用側 |
| [../src/shared/schemas.ts](../src/shared/schemas.ts) | HTTP境界の入力検証と共有契約 |

## 検査の範囲

- PostgreSQLの制約、RLS、RPC、並行処理の整合性を検査します。
- 特権roleだけでなく匿名・認証済みユーザーの権限を確認します。
- Supabase Auth/PostgREST/Storage API、実Turnstile、実Cloudflare Queue/Cronを通す結合検査は別途必要です。
- `tests/bootstrap.sql`には実Storage schemaを含めません。bootstrapや架空テストデータを共有DBへ適用しません。
- 本番の秘密情報や実日記をテストへ渡さず、通常テストから実AIを呼びません。

## 変更時の境界

適用済みmigrationを書き換えず、必要な修正は新しいmigrationにします。
RPCは`READ COMMITTED`で1呼出し1トランザクションとして扱い、ロック順と冪等性を維持します。
ブラウザからの直接書込みを増やしたり、service roleへDDL権限を足して回避したりしません。

`unknown`は外部実行の成否不明として予約を保持し、自動再生成・自動返却しません。
削除の物理回収後も再送防止と費用台帳に必要な最小記録は残ります。手動でcounterや台帳を消さないでください。
Storage設定はschema migrationとは別の操作です。適用先と権限を確認し、運用手順の専用操作で扱います。
DBの巻戻し・reset・migration履歴の修復を通常の復旧手段にしません。
