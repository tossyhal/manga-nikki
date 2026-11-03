# HTTP APIと共通契約v1（API）

> エンドポイント共通プレフィックス：`/api/v1`
> 以下はフロントエンド・バックエンド・DB・AIアダプター間の共通契約です。各機能の実装状況は「初期基盤の実装範囲」に記載します。

### 初期基盤の実装範囲

localhost限定のモックで下記HTTP APIを実装しています。`/config.dataMode`で画面が認証・保存方式を選び、モードの判定はサーバーが行います。`generationAvailable`はこの基盤ではlocal-mockだけtrueです。

モックのBearerは`mock:<ランダムUUID>`で、ブラウザには仮セッションIDだけを保存します。`captchaToken`は空文字です。本物のJWT・Turnstileとは互換にせず、開発ビルドかつloopbackへの要求だけで許可します。生成は固定fixtureを即時確定し、Queue・実AIは呼びません。`mock: true`を生成結果へ付けます。画像URLは公開の架空サンプルであり、Storageの署名URLではありません。

liveモードではSupabase access token検証と日記CRUDを実装しています。日記一覧・詳細の読み取りは利用者JWT + RLSとAPI側のowner条件を使い、作成・編集・論理削除はサーバー専用RPCを使います。日記詳細は既存の`latestGeneration`状態も読み取ります。generation受付・quota・独立した`GET /generations/:id`・画像Storage/署名URL・期限切れ物理削除・Queueは未実装で、該当APIは503を返します。live APIがモックrepositoryへ切り替わることはありません。モックは再起動で消える一時メモリで、実Supabase環境の結合確認は未実施です。

---

## 1. 共通規則

- データ形式
  - 文字コードはUTF-8のJSON、プロパティ名は`camelCase`。
  - 各種IDはすべて`UUID`形式。
  - 日時はUTCのISO 8601形式（例：`2026-10-27T12:00:00Z`）、日記の日付（`diaryDate`）は`YYYY-MM-DD`形式。
  - 定義されていない未知のプロパティが特権項目へ紛れ込むのを防ぐため、リクエストはすべてZodのstrict schemaで検証し、未知のキーがあれば拒否します。
- 認証と所有者判定
  - 保護されたAPIには`Authorization: Bearer <Supabase access token>`ヘッダーを付与します。
  - `auth.getClaims(jwt)`でJWT署名と期限を検証し、サーバーがさらにissuerが`${SUPABASE_URL}/auth/v1`、audienceが`authenticated`、`sub`がUUID形式であることを確認します。続けて`auth.getUser(jwt)`でAuthサーバーの現在のユーザーを照会し、ID一致を確認します。検証済み`sub`だけをサーバー内の所有者として扱います。即時失効を保証するものではなく、詳細は[OPERATIONS](OPERATIONS.md#認証とセッション失効の確認範囲)を参照してください。
  - JWKS取得などAuth依存先が利用できない場合は503、JWT不正やclaim不一致は401を返します。公開の`/health`・`/config`はJWTを要求しません。
  - リクエスト本文やクエリに`userId`は含めません（必ず検証済みJWTの`sub`から所有者を特定します）。
- レスポンスとエラー形式
  - エラー時もHTMLではなく必ずJSONを返します。
  - すべてのAPIレスポンスに`Cache-Control: no-store`を付与します。
  - エラーレスポンスにはSQL文、スタックトレース、AIプロバイダの生レスポンス、秘密情報を含めません。
  - 公開設定（`/config`）にはAPIキー、予算総額、内部のモデル設定を含めません。

```json
{
  "error": {
    "code": "USER_LIMIT_REACHED",
    "message": "本日の生成回数に達しました。",
    "requestId": "server-generated-id",
    "retryable": false
  }
}
```

---

## 2. エンドポイント一覧

| Method / Path | 認証 | リクエスト / レスポンス概要 |
|---|---|---|
| `GET /health` | 不要 | `{ status: "ok", version }`を返す（内部の接続情報は含めない） |
| `GET /config` | 不要 | `{ generationAvailable, dataMode: "mock" | "live" | "sample", consentVersion, retentionDays: 30 }` |
| `GET /me/quota` | 必須 | 自分の`remainingToday`、`activeGenerationId`、JST基準の`resetAt`、`generationAvailable` |
| `POST /entries` | 必須 | `{ createRequestId, diaryDate, body, consentVersion }` → `201` Entry |
| `GET /entries?cursor=...&limit=20` | 必須 | `{ items, nextCursor }`（`limit`は最大50） |
| `GET /entries/:entryId` | 必須 | Entry＋`latestGeneration`＋表示可能な生成結果 |
| `PATCH /entries/:entryId` | 必須 | `{ expectedRevision, diaryDate, body }` → 更新後のEntry |
| `DELETE /entries/:entryId` | 必須 | 論理削除の受付 → `202` `{ deletionAccepted: true }` |
| `POST /entries/:entryId/generations` | 必須 | ヘッダー`Idempotency-Key`、本文`{ expectedRevision, captchaToken }` → `202` GenerationReceipt |
| `GET /generations/:generationId` | 必須 | `status` / `stage`、成功時は`ComicDocument`、失敗時は一般化した`error` |
| `GET /assets/:assetId/url` | 必須 | 所有者確認後に`{ url, expiresAt }`を返す（署名URLの有効期限は60秒） |

`GET /entries`の`nextCursor`は呼び出し側では不透明な値として扱います。live modeは`(diaryDate, id)`をURL-safe base64にして両方の降順順序を維持し、local-mockは既存のentry IDをcursorに使います。初回の`limit`省略時は20件、最大50件です。

### ステータスコードの共通ルール

- 404 Not Found：他人のデータID、削除済みID、期限切れID、存在しないIDへのアクセスは、存在有無を推測されないよう一律で`404`を返します。
- 409 Conflict：
  - 自分の日記に対する更新・生成で`expectedRevision`が一致しない場合は`409`を返します。
  - 下書き作成（`POST /entries`）で同じ`createRequestId`が送られた場合、本文や日付が同じなら既存のEntryを返し（冪等）、異なる内容なら`409`を返します。

---

## 3. 入力制限と編集ルール

<a id="entry-lifecycle"></a>

- 本文とリクエストサイズ
  - `body`（日記本文）：前後の空白をtrimした状態で1〜1,000 Unicodeコードポイント。
  - リクエストJSON全体のサイズ上限：16 KiB（`Content-Type: application/json`も検証）。
- 日付と固定設定
  - `diaryDate`：実在する日付であり、日本時間（JST）の当日以前であること。
  - ロケール（言語）・画風・AIモデル・解像度はユーザー入力では選択させず、サーバー側のMVP設定に固定します。
- 下書き上限と編集競合
  - 未生成の下書きは1ユーザーあたり最大20件まで。
  - 日記の更新には`expectedRevision`の一致が必須です。
  - `queued`または`running`（生成待ち・生成中）のジョブが存在する日記は、本文の変更を`409 ENTRY_BUSY`で拒否します。
  - 生成完了後に日記を編集した場合は`revision`を`+1`増やし、古い漫画を表示する際には画面上で「編集前の日記から生成」と明示します。

### 日付・セッション・削除

- 日付入力の初期値は端末の当日、サーバー検証はAsia/Tokyo、日時保存はUTCです。同日の複数記録を許可します。
- 匿名Authの既存セッションは再利用し、消失時に無断で別ユーザーを作りません。ブラウザデータ削除・シークレット終了・別端末・PWAインストール前後の引き継ぎは保証しません。
- 削除・30日期限切れでは即座に閲覧と新しい署名URLの発行を止めます。物理削除が失敗した場合は再試行し、順序は§9とOPERATIONSに従います。

---

## 4. 生成要求（POST `/entries/:entryId/generations`）の例

### リクエスト

```http
POST /api/v1/entries/11111111-1111-4111-8111-111111111111/generations
Authorization: Bearer <access-token>
Idempotency-Key: 22222222-2222-4222-8222-222222222222
Content-Type: application/json

{"expectedRevision":1,"captchaToken":"fresh-turnstile-token"}
```

### レスポンス（202 Accepted）

```json
{
  "generationId": "33333333-3333-4333-8333-333333333333",
  "status": "queued",
  "statusUrl": "/api/v1/generations/33333333-3333-4333-8333-333333333333"
}
```

### CAPTCHAトークンと再送時の注意

- 匿名サインアップ用のTurnstileトークンと、漫画生成リクエスト用のTurnstileトークンは別々に取得します（1つのトークンを2回の検証に使い回すことはできません）。
- 通信エラー等で同じ`Idempotency-Key`を使って既存リクエストの結果を再照会する場合は、新しいCAPTCHAトークンや追加の生成枠消費は要求しません。ただし、JWT認証・所有者・リクエストハッシュの一致は必ず再確認します。

---

## 5. 漫画データ契約（`ComicDocument` v1）

AIモデルが「4コマ全体を1枚の画像で出力する場合（`page`）」と「1コマずつ計4枚の画像で出力する場合（`panels`）」の違いを、以下の共通型だけで吸収します。AIプロバイダ独自のJSON形式はクライアントへそのまま返しません。

```ts
type Four<T> = [T, T, T, T];

type PanelScript = {
  index: 1 | 2 | 3 | 4;
  scene: string;
  caption: string;
  dialogue: string; // セリフが無いときは空文字 ""（日記にない発言を勝手に作らない）
};

type ComicDocument = {
  schemaVersion: 1;
  title: string;
  panels: Four<PanelScript>;
  visual:
    | { kind: 'page'; assetId: string; textMode: 'embedded' | 'external' }
    | { kind: 'panels'; assetIds: Four<string>; textMode: 'external' };
};
```

### バリデーションと表示ルール

- 文字数上限（Unicodeコードポイント数）
  - `title`：1〜40文字
  - `scene`（場面描写）：各コマ1〜250文字
  - `caption`（説明文）/ `dialogue`（セリフ）：各コマ0〜70文字
- 配列と順序：`panels`は要素数4の固定長で、`index`は`1, 2, 3, 4`が順番に1回ずつ現れることをTypeScriptの型だけでなくZod schemaでも検証します。
- `visual.kind`ごとの扱い
  - `page`（4コマ全体の1枚画像）：テキストを画像外に別描画（`external`）する場合、画像の下に順序付きの4段テキストとして表示して構いません。位置座標が未検証の画像の上に無理に吹き出しを重ねないでください。
  - `panels`（1コマずつ4枚の画像）：4枚の画像を縦1列に並べ、それぞれのコマに対応するテキストを別描画（`external`）します。
- 画像参照のルール：`assetId`はサーバーが採番したStorageアセットのUUIDです。署名URL・Blob・Base64文字列をDBの`ComicDocument`内に直接保存してはいけません。
- サンプルとJSON Schema：
  - [JSON Schema](contracts/comic.schema.json)
  - [1枚方式（page）の例](contracts/comic-page.example.json)
  - [4枚方式（panels）の例](contracts/comic-panels.example.json)
  - ※ これらはドキュメント・テスト用のfixtureであり、実画像や実装コードは含みません。

---

## 6. 生成ジョブ（Generation）の状態遷移

- `status`（6種類）：`queued` | `running` | `succeeded` | `failed` | `unknown` | `cancelled`
- `stage`（進行段階）：`script`（脚本作成中） | `images`（画像描画中） | `saving`（保存中） | `null`

共有型は`src/shared/schemas.ts`の`Generation`です。`succeeded`だけが`comic`を持ち、`failed` / `unknown`は一般化した`error: { code, message, retryable }`を持ちます。画面は状態を確認してから漫画を参照し、画像は`visual`のasset IDからURL取得APIで解決します。`src/shared/fixtures.ts`の`generationFixtures(entryId, generationId)`で待機・実行・成功・失敗・結果不明・中止を再現できます（通常のモックAPIは即時成功）。

### ポーリングと`unknown`状態の扱い

- フロントエンドのポーリング：約5秒間隔を目安に状態を取得します。ブラウザのタブが非表示の間は間隔を延ばすか一時停止し、タブ復帰時に再取得します。終了状態（`succeeded` / `failed` / `unknown` / `cancelled`）になったらポーリングを止めます。
- `unknown`の定義は[用語集](../README.md#glossary)を参照してください。自動再生成はせず、サーバー・運用側で調査します。
- 手動で新しい生成ジョブを作る場合も新たな枠を消費し、古いジョブは上書きしません。

---

## 7. 冪等性（Idempotency）の保証

通信の不安定なスマートフォン環境で、ボタン連打やリトライによって同じ日記から重複してAI生成・課金が走るのを防ぎます。

- フロントエンドの責務
  - 1回の「漫画にする」操作につき1つのUUID（`Idempotency-Key`）を発行し、リトライやページ再読込後の再送でも同じキーを使い続けます。
  - ネットワークエラー時は、先に`GET`で既存ジョブの有無を確認するか、同じ`Idempotency-Key`で再送します（勝手に新しいUUIDを振り直さないこと）。
- サーバー側の検査
  - DBの`UNIQUE(owner_id, idempotency_key)`制約と、正規化したリクエストハッシュ（canonical request hash）で検査します。
  - リクエストハッシュは`API version`・`entryId`・`expectedRevision`から計算し、サーバーが取得したそのrevision時点の日記本文を`input_snapshot`として保存します。
  - 後からサーバーのAIモデル設定が変わっても、過去の同じキーを新しい別生成へ流用しません。
  - 同じ`Idempotency-Key`で異なる対象やrevisionが送られた場合は、`409 IDEMPOTENCY_CONFLICT`で拒否します。
  - DBでの枠予約が成功した後にCloudflare Queueへの送信だけが失敗した場合でも、DB上のジョブは保持し、定期バッチ（reconcile）でQueueへ再送します。

---

## 8. エラーコード一覧

| HTTP | Error Code | クライアント側の対応・画面表示 |
|---|---|---|
| `400` | `INVALID_INPUT` | 入力内容（文字数や日付など）の該当箇所を修正するよう案内 |
| `401` | `AUTH_REQUIRED` / `AUTH_EXPIRED` | 既存の匿名セッションを更新。無断で別の新しい匿名ユーザーを作らない |
| `403` | `CAPTCHA_FAILED` / `CONSENT_REQUIRED` | 新しいTurnstileチャレンジの取得、または利用同意画面の表示 |
| `404` | `NOT_FOUND` | 対象のデータが存在しない旨を表示 |
| `409` | `REVISION_CONFLICT` / `ENTRY_BUSY` / `IDEMPOTENCY_CONFLICT` | 最新データの再読込、または進行中の既存ジョブの確認へ誘導 |
| `413` | `INPUT_TOO_LARGE` | 入力サイズの削減を案内 |
| `429` | `DRAFT_LIMIT_REACHED` | 下書き上限。不要な記録の削除を案内 |
| `429` | `USER_LIMIT_REACHED` / `GLOBAL_LIMIT_REACHED` / `TOO_MANY_ACTIVE` | 新規生成を停止。架空サンプルや保存済み履歴の閲覧は引き続き利用可能と案内 |
| `503` | `GENERATION_DISABLED` / `DEPENDENCY_UNAVAILABLE` | サービス停止中または一時障害を表示し、ボタンを繰り返し連打させない |

※ 生成ジョブが一度受付（`202`）された後に起きたAIプロバイダ等の失敗は、HTTPエラーではなく`GET /generations/:generationId`（HTTP `200`）のレスポンス内の`status: "failed" | "unknown"`と`error`情報で返し、「再試行してよいか」と「費用発生の不確実性」を区別して伝えます。

---

## 9. データベース・Storageの保存契約

日記本文やジョブ状態の正本はPostgreSQL、生成画像の正本はprivate Storageとします。
（※以下はSQL migrationの設計契約であり、現時点では未適用です。データの書き込みはすべてサーバー専用RPC経由で行い、読み取りは利用者JWT + RLSを使用します。詳細な権限設定は[OPERATIONS.md](OPERATIONS.md)を参照してください）。

日記・生成ジョブ管理テーブル、生成元`is_mock`、private予算台帳と`reserve_generation` RPCのmigrationを追加済みです。日記CRUDのHTTP接続は実装済みですが、共有DBへmigrationはまだ適用していません。生成受付HTTP API・Queue・実AI・画像保存は後続です。DB RPCの引数、権限、ロックとエラーの接続契約は[DB基盤の説明](../supabase/README.md)を参照してください。`entries.create_request_hash`は作成要求の再送を編集後も判定する内部列で、クライアントには公開しません。

`generations.is_mock`は生成元metadataです。後続のjob writerは固定結果なら`true`、実生成なら`false`を必ず設定します。既存jobなどで`NULL`の場合は由来不明としてdetail APIを503にし、現在の`AI_MODE`から生成元を推測しません。

### テーブル設計

| テーブル名 | 主なカラム | 主な制約・役割 |
|---|---|---|
| `public.entries` | `id`, `owner_id`, `create_request_id`, `diary_date`, `body`, `revision`, `latest_generation_id`, `consent_version`, `created_at`, `updated_at`, `deleted_at`, `expires_at` | PK `id`、`UNIQUE(owner_id, create_request_id)`、本文長・revisionのCHECK制約 |
| `public.generations` | `id`, `entry_id`, `owner_id`, `entry_revision`, `idempotency_key`, `request_hash`, `input_snapshot`, `model_profile_snapshot`, `claim_token`, `deadline_at`, `status`, `stage`, `comic_json`, `error_code`, `is_mock`, `created_at`, `updated_at`, `enqueued_at`, `started_at`, `completed_at`, `cancel_requested` | `UNIQUE(owner_id, idempotency_key)`、`status`のCHECK制約、entry所有者との整合性保証。`is_mock`は生成元を記録し、NULLは由来不明 |
| `public.assets` | `id`, `generation_id`, `owner_id`, `object_path`, `media_type`, `byte_size`, `width`, `height`, `created_at` | `UNIQUE(object_path)`、許可MIMEタイプ、ファイルサイズ上限の制約 |
| `private.generation_policy` | `id=1`, `enabled`, `user_daily_limit`, `global_daily_limit`, `global_total_limit`, `budget_micro_usd`, `model_profile_json` | 初期値は`enabled=false`、全体枠/予算`0`。管理者のみ操作可能 |
| `private.quota_counters` | `scope`, `subject`, `day_key`, `count`, `committed_micro_usd` | `(scope, subject, day_key)`の一意制約。並行予約時に行ロックして集計 |
| `private.reservations` | `generation_id`, `owner_id`, `reserved_day`, `max_cost_micro_usd`, `state`, `created_at` | `UNIQUE(generation_id)`。`state`は`reserved` / `consumed` / `held` / `released` |
| `private.provider_attempts` | `generation_id`, `stage`, `call_index`, `state`, `request_id`, `started_at`, `finished_at` | `UNIQUE(generation_id, stage, call_index)`。AIモデルの重複呼び出しを防止 |

`generation_policy`の初期値は`enabled=false`、`user_daily_limit=2`、全体日次枠・全期間枠・予算が`0`、`model_profile_json={}`です。profileは外部リクエストでは選択できず、DB policy内の選択済み値を使います。設定する場合は内部profileの`profile_id`・`is_mock`・整数`max_cost_micro_usd`を検証し、`is_mock=false`では最大費用を正数にします。provider/modelなどの他設定はprofile snapshotに保持します。

- 所有者とスキーマ保護：`owner_id`は検証済みJWTの`sub`から設定し、`entry`・`job`・`asset`の間でも所有者が一致することを照合します。`auth.users`はSupabase管理とし、`private`スキーマは外部Data APIへ公開しません。
- 主なインデックス：`entries(owner_id, diary_date, id)`、`generations(owner_id, created_at)`、`generations(status, created_at)`、`assets(generation_id)`。
- スナップショットとポインタ更新：生成予約時点の日記本文とモデル設定をsnapshotカラムへ固定し、`entries.latest_generation_id`を更新します（後から古いジョブが完了しても、新しいポインタを上書きしません）。

### サーバー専用RPC（ストアド関数）一覧

| RPC名 | 呼び出し元 | 処理内容・保証する条件 |
|---|---|---|
| `create_entry` | Worker（Supabase secret keyを使うclientのみ） | `actorId`は検証済みJWT由来。同一`createRequestId`は冪等に処理し、下書き件数上限と本文を検証 |
| `update_entry` | 同上 | 所有者、`revision`の一致、進行中（active）ジョブが無いことを検査して更新 |
| `request_entry_deletion` | 同上 | 所有者確認、日記の論理削除、進行中ジョブへの`cancel_requested`設定 |
| `reserve_generation` | 同上 | `p_generation_enabled`とDB policyの二重停止、所有者・同意・`revision`、冪等性、active job、ユーザー枠/全体枠、policyの最大費用を1トランザクションで検査し、job・reservation・counter・最新jobポインタを原子的に更新 |
| `claim_generation` | Queue Consumer | `queued`状態のジョブだけを`running`へ遷移させ、`claimToken`を発行 |
| `begin_provider_attempt` | Queue Consumer | `claimToken`の一致と同一`(stage, call_index)`が未実行であることを検査し、`dispatched`を記録 |
| `complete_generation` | Queue Consumer | `claimToken`、未削除状態、アセット数と所有権を検証し、生成結果を確定 |
| `fail_or_hold_generation` | Consumer / 定期照合 | 外部AI呼び出し済みなら保守的に`held` / `consumed`を維持。外部未送信が確認できた場合のみ枠を`release`（返却） |

- デッドロック防止のロック順序：`reserve_generation` RPCは、冪等性確認・枠確保・金額予約・ジョブ作成・ポインタ更新を1トランザクションで処理します。policy用2整数advisory transaction lock→global total→global day→user day→entry/jobの固定順序でロックし、キャンセル・解放処理でも同じ順を守ります。policy更新triggerも同じadvisory lockを取るため、運用者はpolicy変更を単独の短いtransactionで行い、すぐcommitします。
- `reserve_generation`はWorker環境変数`GENERATION_ENABLED`を信頼した`p_generation_enabled`引数として受け取り、クライアントからは受け取りません。新しいjobではpolicy profileの`model_profile_json`と日記本文/revisionをsnapshotへ固定し、`is_mock`をprofileから明示します。RPCのJSONB結果はSQL側の`generation_id`・`status`・`status_url`で、API担当がHTTP `GenerationReceipt`の`generationId`・`status`・`statusUrl`へmapします。
- 既存キーのlookupは停止設定より先に行い、同一canonical requestなら停止後も既存`generation_id`を返します。CAPTCHA検証はAPI層の責務なので、APIはこの照会をCAPTCHA検証より前に行い、既存要求の再送で新しい枠を消費しません。別entry/revisionで同じキーを使った場合は`IDEMPOTENCY_CONFLICT`です。
- canonical requestはAPI v1・`entryId`・`expectedRevision`のJSONB表現をUTF-8 SHA-256化した値です。JSON body、単価、profile ID、残り枠をRPC引数で受けず、本文・profileはDB正本から取得します。

### Storage（画像保存）と削除・再試行のルール

- 保存先と制限
  - バケット名：`comics`（privateバケット）
  - オブジェクトパス：`<ownerId>/<generationId>/<assetId>.<ext>`
  - 許可する画像形式：`PNG` / `JPEG` / `WebP`のみ（拡張子だけでなく実データのバイナリでも検証）。任意の外部URL・SVG・HTMLは受け付けません。
  - サイズ上限（暫定）：1画像あたり最大8 MiB、1つの4コマ漫画あたり合計16 MiB、アセット数は1個（`page`）または4個（`panels`）。
- 障害時の再試行とデータ削除の順序
  - 保存パスを決定論的に固定し、再試行時に同じ画像か識別できるようにします。Storageへの画像アップロード成功後にDB更新が失敗した場合は、AIを再実行せずアップロード済みの既存画像から完了確定を行います。
  - 削除処理の順序：「① entryの論理削除 → ② ジョブのキャンセルフラグ設定 → ③ Storageの物理画像削除 → ④ DBメタデータの消去」の順に行います。画像を消す前にDB上のパス情報を消してしまわないようにし、未参照の孤児画像も定期掃除します。
  - 予算台帳の保持：ユーザーが日記やスナップショットを削除しても、消費済みの生成回数や支出金額のカウンターは元に戻しません（予算管理に必要な最小限の識別子・金額・状態だけを個人情報と切り離して残します）。

---

## 10. AIアダプター契約

AIモデルを呼び出すアダプター層は、以下の共通インターフェースに従います。

```ts
interface ScriptProvider {
  createScript(input: DiarySnapshot, options: CallOptions): Promise<ScriptResult>;
}

interface ImageProvider {
  render(script: ValidatedScript, options: CallOptions): Promise<RenderedComic>;
}
```

- 入出力の役割
  - `CallOptions`：中断用の`AbortSignal`、`generationId`、`callIndex`、許可された`modelProfile`を渡します。
  - `ScriptResult`：スキーマ検証済みの4コマ脚本データ。
  - `RenderedComic`：`page`画像1枚または`panels`画像4枚のバイナリデータに加え、プロバイダから取得できる`requestId`・`modelId`・トークン等の`usage`情報を含めます。
- アダプターの境界ルール
  - アダプター自身はDB・HTTPレスポンス・利用枠（quota）を直接操作しません。
  - 保存service側が`RenderedComic`の画像をStorageへ保存して`assetId`に変換し、最終的な`ComicDocument`を組み立てます。
  - 巨大な画像Base64データをHTTPのJSONレスポンスやDBの`comic_json`カラムへ直接埋め込んではいけません。
  - AIプロバイダが画像バイナリではなく一時URLを返す場合のダウンロード制約は、[OPERATIONS.md](OPERATIONS.md)のセキュリティ規則に従います。
