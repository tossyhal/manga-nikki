# 日記DB基盤

本書の実装状況はPR#23までの未マージStackの実装基準HEAD`f255783`（この文書更新commitより前）を指し、`main`にはまだ統合されていません。段階ごとの詳細は[開発計画](../docs/PLAN.md)を参照してください。

`migrations/20261102000000_diary_database.sql`は日記・生成ジョブ管理のテーブル、読み取り用RLS、日記操作用RPCを追加します。`20261103000000_generation_source.sql`は生成元`is_mock`を記録する列を追加し、`20261103010000_generation_reservations.sql`はprivate予算台帳と`find_generation_receipt` / `reserve_generation` RPCを追加します。`20261103020000_generation_execution.sql`はprovider attempt台帳、job claim、attempt開始・確定、失敗時のrelease / hold RPCを追加します。`20261103030000_generation_queue.sql`はmock専用受付、quota取得、固定fixture完了、Queue再送記録と候補照合RPCを追加します。`20261103040000_retention_cleanup.sql`は期限切れ物理削除RPC、assets metadata、本文なしのtombstone/監査台帳とgeneration idempotency archiveを追加します。`20261105000000_openai_generation_saving.sql`は固定OpenAI profile allowlist、OpenAI専用の原子的予約、対応profileのquota評価、claimの日記日付、保存開始ゲートを追加します。local-connectedの受付API・固定mock Queue Consumerと期限削除Scheduled handlerを実装済みです。OpenAI脚本・白黒画像のadapterとQueue経路を追加していますが、画像のprivate Storage保存・assets登録・succeeded確定RPC・署名URLは未接続です。実API課金・共有DBへのmigration適用・実Turnstile・実Cloudflare Queue / Cronの結合は未実施です。過去の隔離環境で一部のAuth / CRUD / 固定mock Queue / Storage削除service / bucket RLSを確認していますが、最新branchの全経路を確認したものではありません。

## 検証

PostgreSQL 16のサーバーとクライアントのバイナリ（`initdb`、`pg_ctl`、`psql`）を用意して実行します。Node.js・pnpmはリポジトリのmise設定を使います。

```sh
pnpm test:db
```

`pg_config --bindir`でバイナリの場所を取得します。見つからない場合は`PG_BIN`にPostgreSQLの`bin`ディレクトリを指定します。WindowsではPowerShellで`$env:PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'`と設定できますが、Windows実機では未検証です。

テストは一時ディレクトリに空のクラスタを作り、空いているlocalhostのTCPポートで起動します。TCP認証には一時的なランダムパスワードとSCRAM-SHA-256を使います。既存の接続先を示す`PG*`環境変数は使用せず、起動失敗や`SIGINT`・`SIGTERM`を含む終了時に一時クラスタだけを停止・削除します。外部接続先・事前に用意したパスワード・実ユーザーデータは不要です。rootではなく通常ユーザーで実行してください。

- `tests/bootstrap.sql`は隔離DB専用です。Supabase管理のロール、最小限の`auth.users`、JWTの`sub`を読む`auth.uid()`を再現します。共有DBや本番には適用しません。
- `tests/diary.sql`はトランザクションをロールバックし、実際に`anon`・ユーザーA/Bの`authenticated`・`service_role`へ切り替えて検証します。
- `tests/reservations.sql`は架空profileと仮想予算を使い、private権限・入力検証・receipt照会の副作用がないこと・停止後再送・日記snapshot・quota集計を検証します。実AIは呼び出しません。
- `tests/generation_queue.sql`は停止中のmock専用予約・実profile拒否・fixture完了とconsumed台帳・未送信release・削除/期限照合・未配送再送抑止・unknown/heldとRPC権限を検証します。実AIや外部Queueは呼び出しません。
- `tests/openai_generation.sql`は固定OpenAI profile allowlist・環境/DB停止・非mock quota・費用/全体枠・所有者分離・claim日付・5 attempt完了・保存開始前の削除/期限・冪等なsaving再送・RPC権限を検証します。実AIや画像保存は呼び出しません。
- `tests/retention.sql`はasset owner/effective-entry RLS、path制約、active job待ち、stale lease、Storage成功後のfinalize、held台帳・provider ID保持、counter不変、tombstoneを検証します。Storageの独立API・RLSは対象外です。
- 実行スクリプトは複数接続を使い、同じ作成キーの同時要求、内容の競合、同時編集、最後の下書き枠、同一生成キー6並列、ユーザー同時実行上限、最後の全体生成枠、ロック待ち中に期限を迎えた生成claim / attempt / 精算、およびowner advisory lock下のpurge/create replay競合を検証します。
- 実SupabaseのAuth・PostgREST・Storageを経由するテストは別途必要です。この検証はPostgreSQLの制約・RLS・RPCを対象にします。

## 保存API担当との接続契約

書き込みはWorker内のサーバー専用Supabaseクライアントから呼び出します。`p_actor_id`には、Workerが署名・issuer・audience・期限を検証し、Authから現在のユーザーも確認したJWTの`sub`だけを渡してください。本文中の所有者指定は使いません。RPCの実行権限は`service_role`だけに付与し、関数は`SECURITY INVOKER`・空の`search_path`で動作します。`service_role`はpolicyをSELECTのみ、quota counterをSELECT・INSERT・UPDATE、reservation ledgerをSELECT・INSERT・`state`列UPDATEできます。provider attempt ledgerはSELECT・INSERTでき、UPDATEは`state`・`request_id`・`finished_at`列に限定します。どちらのprivate ledgerもDELETE権限はありません。SECURITY INVOKER関数を使うため、これらの最小DMLはDBロールにも必要です。一般ユーザーの権限はなく、アプリの通常経路はRPC専用client factoryに限定します。

| RPC | 引数 | 戻り値 |
|---|---|---|
| `create_entry` | `p_actor_id uuid`, `p_create_request_id uuid`, `p_diary_date date`, `p_body text`, `p_consent_version text` | `entries`の1行 |
| `update_entry` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_diary_date date`, `p_body text` | 更新後の`entries`の1行 |
| `request_entry_deletion` | `p_actor_id uuid`, `p_entry_id uuid` | `{"deletionAccepted":true}` |
| `find_generation_receipt` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_idempotency_key uuid` | 既存時はreceipt JSONB、未登録時は`null`。別request hashなら`IDEMPOTENCY_CONFLICT` |
| `reserve_generation` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_idempotency_key uuid`, `p_generation_enabled boolean` | SQL JSONB `{"generation_id":"…","status":"queued","status_url":"/api/v1/generations/…"}`; API maps to `GenerationReceipt` camelCase |
| `reserve_mock_generation` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_idempotency_key uuid` | local-connected専用。receiptを先に照会し、policy lock下で有効なmock profileのみ既存の`reserve_generation(..., true)`へ渡す。実profileは拒否 |
| `reserve_openai_generation` | `p_actor_id uuid`, `p_entry_id uuid`, `p_expected_revision integer`, `p_idempotency_key uuid`, `p_generation_enabled boolean` | 環境停止とDB policyを両方確認し、固定OpenAI profileに一致する場合だけ既存`reserve_generation`へ渡す。receiptを先に照会し、policy lock後に再確認する。戻り値は`reserve_generation`と同じ |
| `get_generation_quota` | `p_actor_id uuid` | JST残数・active generation・次回resetと、DB policy / global枠 / 予算を反映したavailabilityを内部JSONBで返す。有効なmock profileと固定OpenAI profileを評価し、未対応real profileは利用不可にする |
| `claim_generation` | `p_generation_id uuid` | claimできた場合はsnapshot・`diary_date`・`claim_token`・`deadline_at`を含むJSONB、重複配信・削除・期限切れ・cancel要求済みjobは`null`。日記期限を全ロック取得後に確認し、その時刻から15分のclaim期限を設定 |
| `begin_provider_attempt` | `p_generation_id uuid`, `p_claim_token uuid`, `p_stage text`, `p_call_index integer`, `p_generation_enabled boolean` | JSONB `{"attempt_id":"…","generation_id":"…","stage":"script|images","call_index":1,"mode":"mock|provider","is_mock":true}`。全ロック取得後の現在時刻でclaim期限/entry/cancel/policyを再確認します。script成功後の初回image開始と同じtransactionでstageを進め、scriptは1回、imageはprofileの`max_image_calls`まで連番で開始可能。mockは`mode=mock`で返り外部AIへ送信しない |
| `finish_provider_attempt` | `p_generation_id uuid`, `p_claim_token uuid`, `p_attempt_id uuid`, `p_state text`, `p_request_id text default null` | JSONB `{"attempt_id":"…","state":"succeeded|failed|unknown","request_id":null,"finished_at":"…","is_mock":true}`。同じ結果の再送は冪等 |
| `mark_generation_saving` | `p_generation_id uuid`, `p_claim_token uuid` | service_role専用。claim・期限・entry有効性・cancel・nonmock profile・予約額とsnapshotの整合性・script 1件とimage 4件の全成功を確認してstageを`saving`へ移す。statusは`running`、reservationは`reserved`のまま。画像の保存や完了確定は行わず、同じclaimと状態の再送だけ同じ結果を返す |
| `fail_or_hold_generation` | `p_generation_id uuid`, `p_claim_token uuid`（queued jobや期限切れclaimは`null`）, `p_terminal_status text` (`failed` / `cancelled`) | JSONB `{"generation_id":"…","status":"failed|cancelled|unknown","reservation_state":"released|consumed|held","released":true}`。全ロック後に期限を再確認し、外部未送信の証拠がある場合だけ予約を返却 |
| `complete_mock_generation` | `p_generation_id uuid`, `p_claim_token uuid`, `p_comic_json jsonb` | 期限内・未削除・mock profile・script/image attempt成功・固定comic schemaを検証してcomic JSONとconsumed台帳状態を確定。画像binaryやStorageは扱わない |
| `mark_generation_enqueued` | `p_generation_id uuid` | 再送間隔を記録し、未配送queued jobの即時Cron再送を抑える |
| `list_generation_reconcile_candidates` | `p_limit integer`（最大50、default 25） | service_role専用。再送・削除/期限cancel・期限切れrunning照合に必要なgeneration ID/actionだけを返す |

DB行はsnake_caseです。API担当は`id`・`diary_date`・`body`・`revision`・`latest_generation_id`・`created_at`・`updated_at`を共有型`Entry`のcamelCaseへ変換し、内部カラムをHTTPレスポンスに含めないでください。

読み取りは利用者JWTのクライアントを使います。`select('*')`ではなく必要な列を指定してください。`entries.create_request_hash`と、生成ジョブの`input_snapshot`・`model_profile_snapshot`・`claim_token`等の内部列にはクライアントの読み取り権限を付けていません。`generations.is_mock`だけを出力由来表示のためauthenticatedへ追加grantし、job writerがtrue/falseを明示します。既存行はNULLのままにし、由来を確認できない場合はAPIが503を返します。日記とジョブは所有者一致・未削除・期限内の場合だけ取得できます。

認証middlewareは`auth.getClaims(jwt)`で署名・期限とclaimを検証した後、`auth.getUser(jwt)`でAuthサーバーにユーザーを照会します。Supabaseの説明では`getUser`をサーバー側でセッション終了を検出するために使いますが、sign-out済みaccess tokenも`exp`までは有効とされており、これは即時失効の保証ではありません。`auth.sessions`の`session_id`照会は今回追加していません。

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

`reserve_openai_generation`は`p_generation_enabled`をWorkerの`GENERATION_ENABLED`から受け取り、DB policyがenabledかつ下記の固定profile allowlistに一致する場合だけ新しいjobを予約します。receipt照会を先に行い、policy advisory lock取得後に再照会するため、環境停止・DB停止・profile変更後も同一要求の既存receiptは維持し、並行要求で予約を重ねません。`get_generation_quota`は既存のJSON shapeを保ち、有効なmock profileに加えてこの固定OpenAI profileの費用と枠を評価し、未対応real profileは利用不可として返します。

```json
{
  "profile_id": "openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1",
  "is_mock": false,
  "max_cost_micro_usd": 1,
  "max_image_calls": 4,
  "provider": "openai",
  "script_model": "gpt-4.1-mini-2025-04-14",
  "image_model": "gpt-image-2.5-flare",
  "color_mode": "monochrome"
}
```

`max_cost_micro_usd`だけDB管理の正整数として変えられます。他の値は固定照合し、余分なprofile keyは拒否します。

- 作成時の正規化済み日付・本文・同意バージョンをSHA-256にして`create_request_hash`へ保存します。編集後に元の作成要求を再送しても同じ日記の現在の行を返し、別の要求内容は`409`にします。削除済み・期限切れは同じキーでも復活させず`404`にします。
- RPCの競合契約はPostgreSQLの`READ COMMITTED`と、1 RPC呼び出しを1トランザクションとして実行することを前提にします。呼び出し側で分割した複数RPCを1つの原子操作とみなさず、分離レベルも独断で変更しないでください。
- 作成は所有者UUIDの64bitハッシュによるトランザクションadvisory lockで直列化します。下書きは「未削除・期限内・`latest_generation_id is null`」を数え、最大20件です。削除済み・期限切れの記録は枠を使いません。
- 編集・削除は先に日記行を`FOR UPDATE`でロックします。削除は日記を非表示にしてからactiveジョブへ`cancel_requested`を付け、同じトランザクションで確定します。生成枠の解放やジョブの実行結果の確定は行いません。
- 生成予約RPCは日記の有効性・revisionを再確認し、同じ日記行をロックしたままジョブ作成・`latest_generation_id`更新を行います。これが編集・削除との競合防止の前提です。全体policy等のロック順は`docs/API.md`の順序を維持し、entry→jobの順にします。
- quota lockを取るreserve/claim/attempt/settlement RPCは、policy用advisory lock `(20261103, 10001)`→global total→global day→user day→entry→job→attemptの順で行ロックします。削除受付はentry/jobだけをロックしてcancel flagを立て、同じtransaction内ではquotaを触りません。予約時に記録した`reserved_day`のカウンターを使い、entry/jobを保持したままquotaロックを取りに行かないでください。`reserve_mock_generation`もadvisory lockを保持したまま既存予約RPCへ渡し、mock profile確認と予約の間でpolicy変更を通しません。
- `reserve_generation`は`p_generation_enabled`をWorkerの`GENERATION_ENABLED`環境設定から受け取るサーバー専用の信頼値として扱います。ブラウザから自由指定させず、環境設定がfalseまたはDB policyが無効なら新規予約を止めます。同じキー・同じcanonical requestの既存job照会は、停止後もquota/CAPTCHAなしで同じ`generationId`を返します。SQL JSONBの`generation_id` / `status` / `status_url`はAPIで`generationId` / `status` / `statusUrl`へmapします。
- APIはCAPTCHA検証前に`find_generation_receipt`を呼び、receiptがなければTurnstile検証後にlocal-connected専用`reserve_mock_generation`を呼びます。実AIを許可した経路では`reserve_openai_generation`を呼びます。lookupが未登録時に予約を作らないため、CAPTCHAを通らず新規予約されることはありません。wrapper内の既存予約RPCも並行要求に備えて既存keyを再確認します。
- `find_generation_receipt`と`reserve_generation`は同じcanonical request hash helperを使います。receiptを返す前に有効な本人entryを確認し、現在revisionの一致は要求しません。削除・期限切れentryは`NOT_FOUND`です。findは停止中も照会でき、quota counter・reservation・generation・日記pointerを書き換えません。mock wrapperはreceipt確認後、policy lock下でprofileを確認してから新しい予約だけを既存RPCへ渡します。
- canonical requestは`{"apiVersion":"v1","entryId":<UUID>,"expectedRevision":<integer>}`のJSONB表現をUTF-8 SHA-256化します。本文はRPCがロックした日記行からsnapshotへ保存し、profileはpolicyの`model_profile_json`全体を固定します。同じキーで対象/revisionが変われば`IDEMPOTENCY_CONFLICT`です。
- profileはpolicy内の選択済み1件を使い、APIリクエストからIDや単価を受けません。`{}`は未設定として停止します。一般profileは`profile_id`（非空文字列）、`is_mock`（boolean）、`max_cost_micro_usd`（非負整数、bigint範囲）を必須にし、`is_mock=false`で0は拒否します。実AI予約は上記の固定profile allowlistだけを受け付け、余分なkeyを拒否します。
- ロックはpolicy用2整数advisory transaction lock `(20261103, 10001)`→global total→global day→user day→entry/jobの順です。既存`create_entry`の1 bigint advisory lockとは別key spaceです。`generation_policy`のBEFORE UPDATE STATEMENT triggerも同じlockを取るため、policy読取はservice_role SELECTだけで行え、管理者更新と予約は直列化されます。global total行を各予約が排他ロックし、全期間枠・予算の最終枠を直列化します。counter行の作成も`INSERT ... ON CONFLICT`で一意キーに集約し、READ COMMITTEDの単一RPCトランザクション内で行います。
- 管理者がpolicyを変更する場合は、変更だけを行う短い単独transactionで更新・commitしてください。更新transactionのcommitまで同じpolicy lockを保持します。
- `reserve_generation`のDB結果はSQL snake_caseのJSONBです。API境界で`generation_id` / `status` / `status_url`をHTTP `GenerationReceipt`の`generationId` / `status` / `statusUrl`へmapし、内部snapshot、profile、費用、reservationをレスポンスへ含めません。
- 日記とジョブの所有者・対象日記の一致は複合外部キーでも保証します。1日記につきactive jobは1つだけです。`is_mock`は生成元の公開metadataで、固定結果ならtrue、実生成ならfalseを必ず設定し、NULLを既定値でfalseに埋めません。Queue Consumerはlocal-connectedで固定mockだけを実行し、実AI経路では上記のOpenAI profileだけを予約します。画像保存・asset登録・実画像用のsucceeded確定RPCは未実装です。
- `latest_generation_id`を保持したまま編集し、`revision`だけを増やします。画面側は`entry_revision`との差から編集前の漫画であることを表示できます。
- `claim_generation`はQueueの重複配信を含め、`queued` jobの1回目だけを`running`にします。日記有効期限は全ロック取得後の時刻で確認し、その時刻から15分のclaim期限を設定します。戻り値にはQueue Consumerだけが使う`diary_date`・日記/profile snapshotとclaim tokenを含みます。重複claimや削除・期限切れ・cancel要求済みjobは`null`です。claim後の期限切れjobは自動再claimしません。
- `begin_provider_attempt`は全ロック取得後の現在時刻でentry/jobの有効性、cancel状態、claim token/期限、reservation、DB policyを再確認します。実AIはWorkerの`p_generation_enabled=true`とDB policyの`enabled=true`を両方要求します。`is_mock=true`はDB snapshotからのみ判定し、`p_generation_enabled=false`でも`mode=mock`だけを開始できます。scriptは1回、imagesはsnapshotの`max_image_calls`まで（未指定1、上限4）連番で開始でき、前のimageの成功後に次へ進みます。最初のimage開始時には`stage`を同transactionで進めます。attempt行は外部送信前にcommitします。mock attemptはAI providerへ渡しません。
- mock profileの`max_image_calls`はDB policy内だけで設定できるoptional整数で、許容値は1〜4、未指定時は1です。固定OpenAI profileでは4に固定します。`max_cost_micro_usd`はscript 1回と許可したimage呼出し数の最大費用を含め、HTTPリクエストからは受け取りません。
- `finish_provider_attempt`はrunning job・一致するclaim token・reserved reservation・dispatch済みattemptを再確認します。外部送信は済んでいるため、削除要求・日記期限・claim期限後でもknown resultとrequest IDを記録します。terminal job・古いtoken・精算済みreservationは変更しません。`request_id`はnullableかつ最大200文字、mockではnullです。`unknown`は自動再実行しません。
- `fail_or_hold_generation`は全ロック取得後の現在時刻でclaim期限を確認し、queued / runningのみをterminalへ遷移させます。non-mockの`dispatched` / `unknown` attemptが残ればjobを`unknown`、reservationを`held`にします。non-mockの既知結果または確定したmock結果は予約最大額を`consumed`にし、外部未送信を証明できる場合だけ`released`へ変更します。releaseは元のJST日のcounterへ1回だけ戻し、terminal job・古いclaim・二重精算では状態やcounterを変更しません。
- `mark_generation_saving`は全ロック後の現在時刻でclaim期限、削除/cancel、entry期限、OpenAI profileと予約額の整合性を確認し、script 1件とimage 4件の成功attemptが揃った場合だけ`stage='saving'`へ移します。statusは`running`、reservationは`reserved`のままです。同じclaim・同じsaving状態の再送だけ同じ結果を返します。画像保存・asset登録・完了確定は行いません。

## 適用と後続作業

この作業では共有Supabaseへの適用は行いません。人間のレビュー後、DB担当が接続先と既存migration履歴を確認し、採用したSupabase CLIのmigration手順で適用します。適用対象は`migrations/`だけです。`tests/bootstrap.sql`やテスト用クラスタを本番へ持ち込まないでください。

実画像のprivate Storage保存・asset登録・succeeded確定RPC・署名URL発行は保存担当との接続後に追加します。保存handlerが未設定の場合はWorkerがprovider呼出し前に未送信を確定して枠をreleaseするため、実AI APIは呼びません。実APIの課金検証と共有DBへの適用は未実施です。local-connected `complete_mock_generation`は固定fixtureとmock ledgerだけを確定します。期限切れentryの物理削除は次節の通り実装済みです。物理削除時には画像削除後、日記の`latest_generation_id`を外してjob→日記の順に消します。`entries`の物理削除で失われる`(owner_id, create_request_id)`はprivate tombstoneへ保持し、削除後の古い`createRequestId`再送を`NOT_FOUND`にします。現在の外部キーは意図しない連鎖削除を行いません。

期限切れentryの物理削除RPCとserver専用cleanup service、`public.assets` metadata契約を追加済みです。claimは削除対象entryとDB上のasset pathを15分leaseへ固定し、Storage通信の完了後にfinalizeします。finalizeはpolicy advisory lock→owner advisory lock→entry→jobの順に再ロックし、active jobなし・期限対象・同じpath集合・Storage成功を確認後、provider attempts / reservationsを削除前にprivateの最小監査台帳へ移します。quota counterは変更しません。generationの`owner_id` / `idempotency_key` / `request_hash`は本文なしの`private.retained_generation_requests`へ退避し、同ownerで同じkeyを別requestに使うと`IDEMPOTENCY_CONFLICT`、purged targetの再送は`NOT_FOUND`になります。予約とpurgeはpolicy advisory lockで直列化します。entryの`latest_generation_id`を外し、asset→job→entryの順に物理削除します。

`private.entry_tombstones`は本文なしのowner / `create_request_id` / purged entry IDを保持し、物理削除後の古い作成再送を`NOT_FOUND`にします。createとpurgeの競合は同じowner advisory lockで直列化します。Scheduled handlerは日次Cronに接続済みです。

Supabase Storage schemaは隔離PostgreSQLのtest bootstrapに含めていません。private bucketと`storage.buckets` / `storage.objects`のcomics専用RESTRICTIVE deny policyは、Storage APIが有効な環境だけで`supabase/storage/comics-bucket.sql`を適用します。roleは両tableを管理できるものにし、検証済みlocal Supabaseでは`supabase_admin`を使います。table ownerは`supabase_storage_admin`で、CLI3の`postgres`には所有権がありませんでした。cloudで必要なroleは未検証です。`service_role`へDDL権限を追加して回避しません。Storageのbucket/object RLSは有効、FORCEは無効の状態を変更せず、既存RLS上にrestrictive deny policyを追加します。local Supabaseではprivate bucket・MIME・8 MiB上限、anon / authenticated A・Bのcomics list / signed URL / upload拒否、public URLの非200、comicsの`updateBucket(public: true)`拒否、service_roleのupload / remove、広域authenticated allow policy下でもcomics denyが残り他bucketの操作を妨げないことを検証しました。bucket公開化の試験では、一時authenticated permissive policyがあってもcomicsだけ拒否され、別bucketの管理は許可されました。cloud環境の適用とStorage API結合は未検証です。Storage保存・asset登録・署名URL発行は別担当の後続作業です。アップロードが削除と競合して未参照objectを残す可能性があるため、保存workerはupload前とmetadata登録前のcancel / expiryを再確認します。自動孤児掃除は未実装です。24時間を超えてactive jobもDB metadataもないobjectだけをdashboardで照合し、手動削除して件数を記録します。

公式資料: [Database Functions](https://supabase.com/docs/guides/database/functions)、[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations)。
