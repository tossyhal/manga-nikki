# 日記DB基盤

日記migrationに加えて、生成元`is_mock`を記録する列と、private予算台帳・`reserve_generation` RPCを追加しています。枠予約はDB内だけで完結し、外部AI・Queue・画像Storageは呼び出しません。DB CRUD/API接続や生成状態遷移、物理削除は別作業です。初期policyは停止中のため、このSQLだけでlive生成が有効になることはありません。

## 検証

PostgreSQL 16のサーバーとクライアントのバイナリ（`initdb`、`pg_ctl`、`psql`）を用意して実行します。Node.js・pnpmはリポジトリのmise設定を使います。

```sh
pnpm test:db
```

`pg_config --bindir`でバイナリの場所を取得します。見つからない場合は`PG_BIN`にPostgreSQLの`bin`ディレクトリを指定します。WindowsではPowerShellで`$env:PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'`と設定できますが、Windows実機では未検証です。

テストは一時ディレクトリに空のクラスタを作り、空いているlocalhostのTCPポートで起動します。TCP認証には一時的なランダムパスワードとSCRAM-SHA-256を使います。既存の接続先を示す`PG*`環境変数は使用せず、起動失敗や`SIGINT`・`SIGTERM`を含む終了時に一時クラスタだけを停止・削除します。外部接続先・事前に用意したパスワード・実ユーザーデータは不要です。rootではなく通常ユーザーで実行してください。

- `tests/bootstrap.sql`は隔離DB専用です。Supabase管理のロール、最小限の`auth.users`、JWTの`sub`を読む`auth.uid()`を再現します。共有DBや本番には適用しません。
- `tests/diary.sql`はトランザクションをロールバックし、実際に`anon`・ユーザーA/Bの`authenticated`・`service_role`へ切り替えて検証します。
- `tests/reservations.sql`は架空profileと仮想予算を使い、private権限・入力検証・停止後再送・日記snapshot・quota集計を検証します。実AIは呼び出しません。
- 実行スクリプトは複数接続を使い、同じ作成キーの同時要求、内容の競合、同時編集、最後の下書き枠、同一生成キー6並列、ユーザー同時実行上限、最後の全体生成枠を検証します。
- 実SupabaseのAuth・PostgREST・Storageを経由するテストは別途必要です。この検証はPostgreSQLの制約・RLS・RPCを対象にします。

## 保存API担当との接続契約

書き込みはWorker内のサーバー専用Supabaseクライアントから呼び出します。`p_actor_id`には、Workerが署名・issuer・audience・期限を検証したJWTの`sub`だけを渡してください。本文中の所有者指定は使いません。RPCの実行権限は`service_role`だけに付与し、関数は`SECURITY INVOKER`・空の`search_path`で動作します。`service_role`はpolicyをSELECTのみ、quota counterをSELECT・INSERT・UPDATE、reservation ledgerをSELECT・INSERTできます。SECURITY INVOKER関数を使うため、これらの最小DMLはDBロールにも必要です。一般ユーザーの権限はなく、アプリの通常経路はRPC専用client factoryに限定します。

| RPC | 引数 | 戻り値 |
|---|---|---|
| `create_entry` | `p_actor_id uuid`, `p_create_request_id uuid`, `p_diary_date date`, `p_body text`, `p_consent_version text` | `entries`の1行 |
| `update_entry` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_diary_date date`, `p_body text` | 更新後の`entries`の1行 |
| `request_entry_deletion` | `p_actor_id uuid`, `p_entry_id uuid` | `{"deletionAccepted":true}` |
| `reserve_generation` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_idempotency_key uuid`, `p_generation_enabled boolean` | `{"generationId":"…","status":"queued","statusUrl":"/api/v1/generations/…"}` |

DB行はsnake_caseです。API担当は`id`・`diary_date`・`body`・`revision`・`latest_generation_id`・`created_at`・`updated_at`を共有型`Entry`のcamelCaseへ変換し、内部カラムをHTTPレスポンスに含めないでください。

読み取りは利用者JWTのクライアントを使います。`select('*')`ではなく必要な列を指定してください。`entries.create_request_hash`と、生成ジョブの`input_snapshot`・`model_profile_snapshot`・`claim_token`等の内部列にはクライアントの読み取り権限を付けていません。日記とジョブは所有者一致・未削除・期限内の場合だけ取得できます。

RPCの業務エラーはSQLSTATE`P0001`、`message`が次の固定コードです。API側で既存のHTTPエラー形式へ変換し、DBの生エラーをそのまま返さないでください。

| コード | HTTP |
|---|---|
| `AUTH_REQUIRED` | 401 |
| `INVALID_INPUT` | 400 |
| `CONSENT_REQUIRED` | 403 |
| `NOT_FOUND` | 404 |
| `IDEMPOTENCY_CONFLICT` / `REVISION_CONFLICT` / `ENTRY_BUSY` | 409 |
| `DRAFT_LIMIT_REACHED` | 429 |
| `USER_LIMIT_REACHED` / `GLOBAL_LIMIT_REACHED` / `TOO_MANY_ACTIVE` | 429 |
| `GENERATION_DISABLED` | 503 |

不正なUUID・実在しない日付などの型変換エラーはRPC実行前にも起きるため、API側のZod検証は維持してください。
`create_entry`は作成INSERT時の`entries_owner_id_fkey`違反だけを`AUTH_REQUIRED`へ変換します。JWT検証後にAuthユーザーが削除された場合も401にできますが、他の外部キー違反はそのまま扱います。

## 冪等性とロック

- 作成時の正規化済み日付・本文・同意バージョンをSHA-256にして`create_request_hash`へ保存します。編集後に元の作成要求を再送しても同じ日記の現在の行を返し、別の要求内容は`409`にします。削除済み・期限切れは同じキーでも復活させず`404`にします。
- RPCの競合契約はPostgreSQLの`READ COMMITTED`と、1 RPC呼び出しを1トランザクションとして実行することを前提にします。呼び出し側で分割した複数RPCを1つの原子操作とみなさず、分離レベルも独断で変更しないでください。
- 作成は所有者UUIDの64bitハッシュによるトランザクションadvisory lockで直列化します。下書きは「未削除・期限内・`latest_generation_id is null`」を数え、最大20件です。削除済み・期限切れの記録は枠を使いません。
- 編集・削除は先に日記行を`FOR UPDATE`でロックします。削除は日記を非表示にしてからactiveジョブへ`cancel_requested`を付け、同じトランザクションで確定します。生成枠の解放やジョブの実行結果の確定は行いません。
- **後続の生成予約RPCも、日記の有効性・revisionを再確認し、同じ日記行をロックしたままジョブ作成・`latest_generation_id`更新を行ってください。**これが編集・削除との競合防止の前提です。全体policy等のロック順は`docs/API.md`の順序を維持し、entry→jobの順にします。
- 後続のquota解放RPCも、`docs/API.md`の「全体policy/total → 全体day → ユーザーday → entry → job」の順で行ロックします。予約時に記録した`reserved_day`のカウンターを使い、entry/jobを保持したままquotaロックを取りに行かないでください。
- `reserve_generation`は`p_generation_enabled`をWorkerの`GENERATION_ENABLED`環境設定から受け取るサーバー専用の信頼値として扱います。ブラウザから自由指定させず、環境設定がfalseまたはDB policyが無効なら新規予約を止めます。同じキー・同じcanonical requestの既存job照会は、停止後もquota/CAPTCHAなしで同じ`generationId`を返します。
- canonical requestは`{"apiVersion":"v1","entryId":<UUID>,"expectedRevision":<integer>}`のJSONB表現をUTF-8 SHA-256化します。本文はRPCがロックした日記行からsnapshotへ保存し、profileはpolicyの`model_profile_json`全体を固定します。同じキーで対象/revisionが変われば`IDEMPOTENCY_CONFLICT`です。
- profileはpolicy内の選択済み1件を使い、APIリクエストからIDや単価を受けません。`{}`は未設定として停止します。設定時は`profile_id`（非空文字列）、`is_mock`（boolean）、`max_cost_micro_usd`（非負整数、bigint範囲）を必須にし、`is_mock=false`で0は拒否します。provider/modelなどの任意設定はsnapshotにそのまま保持します。
- ロックは`generation_policy`共有ロック→global total→global day→user day→entry/jobの順です。global total行を各予約が排他ロックし、全期間枠・予算の最終枠を直列化します。counter行の作成も`INSERT ... ON CONFLICT`で一意キーに集約し、READ COMMITTEDの単一RPCトランザクション内で行います。
- `reserve_generation`のDB結果はJSON camelCaseのGenerationReceiptです。API境界ではsnake_caseのDB列とHTTP共有型を明示的にmapし、内部snapshot、profile、費用、reservationをレスポンスへ含めません。
- 日記とジョブの所有者・対象日記の一致は複合外部キーでも保証します。1日記につきactiveジョブは1つだけです。生成ジョブの外部AI実行や状態遷移のRPCは未実装です。
- `latest_generation_id`を保持したまま編集し、`revision`だけを増やします。画面側は`entry_revision`との差から編集前の漫画であることを表示できます。

## 適用と後続作業

この作業では共有Supabaseへの適用は行いません。人間のレビュー後、DB担当が接続先と既存migration履歴を確認し、採用したSupabase CLIのmigration手順で適用します。適用対象は`migrations/`だけです。`tests/bootstrap.sql`やテスト用クラスタを本番へ持ち込まないでください。

画像保存・Storage権限、予算台帳・予約RPC、Queue実行権と完了確定、期限切れの物理削除・匿名ユーザー削除は別migrationで追加します。物理削除時には画像削除後、日記の`latest_generation_id`を外してジョブ→日記の順に消す必要があります。加えて`entries`を物理削除すると`(owner_id, create_request_id)`の重複記録も消えるため、後続実装では冪等性tombstone等を保持し、削除後の古い`createRequestId`再送で日記を再作成できないようにしてください。現在の外部キーは意図しない連鎖削除を行いません。

公式資料: [Database Functions](https://supabase.com/docs/guides/database/functions)、[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations)。
