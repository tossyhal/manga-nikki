# HTTP APIと共通契約v1（API）

> エンドポイント共通プレフィックス：`/api/v1`
> 以下はフロントエンド・バックエンド・DB・AIアダプター間の共通契約です。各機能の実装状況は「現在の実装範囲」に記載します。

### 現在の実装範囲

PR#29までの変更は`main`へ統合済みです。このPRではOpenAI白黒生成profileと台帳hook、live-demoのQueue経路、保存復旧callback契約を追加します。private Storageへの画像保存本体は保存担当の実装待ちです。新規live生成は保存handlerまたは復旧callbackのどちらか一方でも未注入なら停止します。共有DB migration、実Turnstile・Cloudflare Queue結合、保存handlerの接続、実AIの品質・課金は未確認です。段階ごとの詳細は[開発計画](PLAN.md)を参照してください。

localhost限定のモックで下記HTTP APIを実装しています。`/config.dataMode`で画面が認証・保存方式を選び、モードの判定はサーバーが行います。`/config.generationAvailable`はlocal-mockと、Queue・生成用Turnstileが設定済みのlocal-connectedだけtrueです。local-connectedでの最終的な受付可否は`GET /me/quota`の値も確認します。

モックのBearerは`mock:<ランダムUUID>`で、ブラウザには仮セッションIDだけを保存します。`captchaToken`は空文字です。本物のJWT・Turnstileとは互換にせず、開発ビルドかつloopbackへの要求だけで許可します。生成は固定fixtureを即時確定し、Queue・実AIは呼びません。`mock: true`を生成結果へ付けます。画像URLは公開の架空サンプルであり、Storageの署名URLではありません。

liveモードではSupabase access token検証と日記CRUDを実装しています。日記一覧・詳細・生成状態・quotaの読み取りは利用者JWT + RLSとAPI側のowner条件を使い、書き込み・予約・状態確定はサーバー専用RPCを使います。`local-connected`では生成専用Turnstile検証、冪等予約、Queue、固定mockの状態遷移、未配送・期限照合を接続します。固定mockの画像はgeneration IDをasset IDに使い、本人の有効なmock jobを確認した場合だけ公開の`/sample-comic.svg`を返します。これは架空サンプルで、Storageへの画像保存や実生成を示しません。期限切れ・削除済み日記は日次Scheduled handlerからserver専用cleanup serviceへ渡します。`local-connected`と`live-demo`だけで実行し、sample / malformed modeでは個人DB・Storageへアクセスしません。live-demoの実生成経路はOpenAI白黒profile・原子的予約・Queue・provider attempt台帳を通します。保存handlerの一時障害ではjobを`saving`のまま保持し、復旧callbackがdurableな保存情報から再開します。新規実生成は保存handlerまたは復旧callbackのどちらか一方でも未接続なら受付を停止します。共有DBへのmigration適用、実Turnstile・実Cloudflare Queue / Cronとの結合、保存handler接続、実AIの品質・課金は未確認です。local-mockの即時固定成功と、live APIがmock repositoryへ切り替わらない方針は維持します。

liveのブラウザは`/config`をstrict schemaで検証し、Supabase JS SDKに既存セッションの保存・更新を任せます。ホームのサンプル閲覧や401応答を理由に匿名ユーザーを新規作成しません。入力・閲覧だけでは登録やCAPTCHAを始めず、説明の近くにある保存・生成ボタンを利用者が明示的に押した場合に限って登録を開始します。`POST /entries`には既存契約どおり`consentVersion`を送り、登録用Turnstile tokenをSDKの`signInAnonymously`へ一度だけ渡します。登録用tokenは生成APIへ流用しません。生成用CAPTCHAと利用枠のUIは実装済みで、`local-connected` APIを呼ぶ場合は登録用とは別の生成用tokenが必要です。`live-demo`の新規実AI生成は初期設定では停止しており、必要なready条件が揃った環境だけ受付可能です。実Turnstile結合、共有DBへの適用、最新branchの全経路は未確認です。Supabaseの公開設定または登録用site keyが不足する場合もlive認証を停止し、モックへ切り替えません。

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
- APIサーバーは生成受付時に、JWTから得た所有者・entry・revision・`Idempotency-Key`でサーバー専用`find_generation_receipt` RPCを先に呼びます。receiptがあればCAPTCHAやQueueを呼ばず`202`で返し、`null`ならTurnstile Siteverifyで`hostname`と固定`action=generate`を厳密に確認します。local-connected専用`reserve_mock_generation`はmock policyをロック下で確認してから予約RPCを呼び、実profileを環境停止の迂回に使いません。Queue送信に失敗しても予約済みjobを保持し、定期照合で再送します。

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

共有型は`src/shared/schemas.ts`の`Generation`です。すべてのGenerationレスポンスには生成時の日記改訂番号`entryRevision`を含めます。これは漫画生成時点のEntryの`revision`で、後から日記を編集しても変わりません。HTTP v1のリクエスト契約は変更せず、このレスポンス項目を追加します。`succeeded`だけが`comic`を持ち、`failed` / `unknown`は一般化した`error: { code, message, retryable }`を持ちます。画面は状態を確認してから漫画を参照し、succeededの`entryRevision`が現在のEntryの`revision`より小さい場合は「編集前の日記から生成された漫画です。」と表示します。画像は`visual`のasset IDからURL取得APIで解決します。`src/shared/fixtures.ts`の`generationFixtures(entryId, generationId, entryRevision = 1)`で待機・実行・成功・失敗・結果不明・中止を再現できます（通常のモックAPIは即時成功）。

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
| `401` | `AUTH_REQUIRED` | 既存の匿名セッションを更新。無断で別の新しい匿名ユーザーを作らない |
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
（※以下はSQL migrationの設計契約です。共有DBには未適用で、隔離PostgreSQLによる一部RPC / RLS検証を行っています。データの書き込みはすべてサーバー専用RPC経由で行い、読み取りは利用者JWT + RLSを使用します。詳細な権限設定は[OPERATIONS.md](OPERATIONS.md)を参照してください）。

日記・生成job管理テーブル、生成元`is_mock`、private予算台帳、受付・実行・Queue照合RPCのmigrationを追加済みです。HTTPのlocal-connected固定mock経路に加え、live-demo向けOpenAI profileの予約wrapperとQueue Consumer接続を追加しています。新規実生成は`GENERATION_ENABLED`・DB policy・queue・API key・private画像保存handler・保存復旧callbackのすべてが整わないと受付されません。保存handlerとprivate Storage保存本体は別担当の作業待ちです。共有DBへのmigration適用、実Turnstile・実Cloudflare Queue / Cronとの結合確認、保存handler接続、実AIの品質・課金は未確認です。DB RPCの引数、権限、ロックとエラーの接続契約は[DB基盤の説明](../supabase/README.md)を参照してください。`entries.create_request_hash`は作成要求の再送を編集後も判定する内部列で、クライアントには公開しません。

`generations.is_mock`は生成元metadataです。実装済みの固定mock job writerは`true`を設定し、将来実生成を接続するときは`false`を明示します。既存jobなどで`NULL`の場合は由来不明としてdetail APIを503にし、現在の`AI_MODE`から生成元を推測しません。

### テーブル設計

| テーブル名 | 主なカラム | 主な制約・役割 |
|---|---|---|
| `public.entries` | `id`, `owner_id`, `create_request_id`, `diary_date`, `body`, `revision`, `latest_generation_id`, `consent_version`, `created_at`, `updated_at`, `deleted_at`, `expires_at` | PK `id`、`UNIQUE(owner_id, create_request_id)`、本文長・revisionのCHECK制約 |
| `public.generations` | `id`, `entry_id`, `owner_id`, `entry_revision`, `idempotency_key`, `request_hash`, `input_snapshot`, `model_profile_snapshot`, `claim_token`, `deadline_at`, `status`, `stage`, `comic_json`, `error_code`, `is_mock`, `created_at`, `updated_at`, `enqueued_at`, `started_at`, `completed_at`, `cancel_requested` | `UNIQUE(owner_id, idempotency_key)`、`status`のCHECK制約、entry所有者との整合性保証。`is_mock`は生成元を記録し、NULLは由来不明 |
| `public.assets` | `id`, `generation_id`, `owner_id`, `object_path`, `media_type`, `byte_size`, `width`, `height`, `created_at` | `UNIQUE(object_path)`、許可MIMEタイプ、ファイルサイズ上限の制約 |
| `private.generation_policy` | `id=1`, `enabled`, `user_daily_limit`, `global_daily_limit`, `global_total_limit`, `budget_micro_usd`, `model_profile_json` | 初期値は`enabled=false`、全体枠/予算`0`。管理者のみ操作可能 |
| `private.quota_counters` | `scope`, `subject`, `day_key`, `count`, `committed_micro_usd` | `(scope, subject, day_key)`の一意制約。並行予約時に行ロックして集計 |
| `private.reservations` | `generation_id`, `owner_id`, `reserved_day`, `max_cost_micro_usd`, `state`, `created_at` | `UNIQUE(generation_id)`。`state`は`reserved` / `consumed` / `held` / `released` |
| `private.provider_attempts` | `id`, `generation_id`, `owner_id`, `stage`, `call_index`, `is_mock`, `state`, `request_id`, `started_at`, `finished_at` | `UNIQUE(generation_id, stage, call_index)`。生成jobと所有者の一致、mock由来の固定、AIモデルの重複呼び出し防止 |

`generation_policy`の初期値は`enabled=false`、`user_daily_limit=2`、全体日次枠・全期間枠・予算が`0`、`model_profile_json={}`です。profileは外部リクエストでは選択できず、DB policy内の選択済み値を使います。mock profileは`reserve_mock_generation`だけが受け付けます。実AI用`reserve_openai_generation`は次の固定profileだけを許可します。

| snapshot key | 値・制約 |
|---|---|
| `profile_id` | `openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1` |
| `is_mock` | `false` |
| `max_cost_micro_usd` | DB側で承認・設定する正の整数。現在の料金・予算額は未承認 |
| `max_image_calls` | `4` |
| `provider` | `openai` |
| `script_model` | `gpt-4.1-mini-2025-04-14` |
| `image_model` | `gpt-image-2.5-flare` |
| `color_mode` | `monochrome` |

`max_cost_micro_usd`はscriptを1回、imageを最大4回実行する費用上限を含めます。profile snapshotは予約時に固定し、HTTP bodyからモデル・料金・枠を選べません。

- 所有者とスキーマ保護：`owner_id`は検証済みJWTの`sub`から設定し、`entry`・`job`・`asset`の間でも所有者が一致することを照合します。`auth.users`はSupabase管理とし、`private`スキーマは外部Data APIへ公開しません。
- 主なインデックス：`entries(owner_id, diary_date, id)`、`generations(owner_id, created_at)`、`generations(status, created_at)`、`assets(generation_id)`。
- スナップショットとポインタ更新：生成予約時点の日記本文とモデル設定をsnapshotカラムへ固定し、`entries.latest_generation_id`を更新します（後から古いジョブが完了しても、新しいポインタを上書きしません）。

### サーバー専用RPC（ストアド関数）一覧

| RPC名 | 呼び出し元 | 処理内容・保証する条件 |
|---|---|---|
| `create_entry` | Worker（Supabase secret keyを使うclientのみ） | `actorId`は検証済みJWT由来。同一`createRequestId`は冪等に処理し、下書き件数上限と本文を検証 |
| `update_entry` | 同上 | 所有者、`revision`の一致、進行中（active）ジョブが無いことを検査して更新 |
| `request_entry_deletion` | 同上 | 所有者確認、日記の論理削除、進行中ジョブへの`cancel_requested`設定 |
| `find_generation_receipt` | 同上 | 有効な本人entryの既存キーだけを照会し、receipt / `null` / `IDEMPOTENCY_CONFLICT`を返す。quota・job・pointerを書き換えない |
| `reserve_generation` | 同上 | `p_generation_enabled`とDB policyの二重停止、所有者・同意・`revision`、冪等性、active job、ユーザー枠/全体枠、policyの最大費用を1トランザクションで検査し、job・reservation・counter・最新jobポインタを原子的に更新 |
| `reserve_mock_generation` | local-connected Worker | receiptを先に照会し、policy用advisory lockの下でenabledかつmock profileを確認した場合だけ既存の`reserve_generation(..., true)`へ渡す。実profileは受け付けない |
| `reserve_openai_generation` | live-demo Worker | receiptを先に照会し、`generation_enabled=true`と上記固定OpenAI白黒profileをpolicy lock下で確認してから予約する。モデル、料金、呼出上限は入力から選べない |
| `get_generation_quota` | Worker | 検証済み`sub`のJST日次残数・active generation・reset日時と、DB policy / 全体枠・予算を反映したmock利用可否を返す |
| `claim_generation` | Queue Consumer | `p_generation_id uuid`。queued jobを1Consumerだけがrunningへ移し、全ロック取得後から15分の`claim_token`を設定。日記の日付・本文・profile snapshotとtoken/deadlineを返す。日記期限はロック後の時刻で確認し、削除・期限切れ・cancel要求済みjobは`null` |
| `begin_provider_attempt` | Queue Consumer | `p_generation_id uuid`, `p_claim_token uuid`, `p_stage text`, `p_call_index integer`, `p_generation_enabled boolean`。全ロック取得後の現在時刻でclaim期限・entry・cancel・policyを再検査し、送信前にattemptを記録。script成功後の最初のimages開始と同じtransactionで`stage`も進める。返値`{attempt_id,generation_id,stage,call_index,mode,is_mock}`。scriptは1回、imagesはsnapshotの`max_image_calls`まで（未指定1、上限4）成功ごとに次を許可。`mode=mock`は実AIを呼ばない専用経路で、`GENERATION_ENABLED=false`でもprofile由来`is_mock=true`だけを許可 |
| `finish_provider_attempt` | Queue Consumer | `p_generation_id uuid`, `p_claim_token uuid`, `p_attempt_id uuid`, `p_state text`, `p_request_id text default null`。running job・一致するclaim token・reserved枠に属するdispatch済みattemptだけを確定。同じ確定値の再送だけ冪等。削除要求・entry期限・claim期限後の既知結果も記録し、job終端状態は戻さない |
| `mark_generation_saving` | live-demo Queue Consumer | 完了済みscript 1回・image 4回のattempt、claim、期限、削除/cancel、予約額とsnapshotの整合性を再確認してstageを`saving`へ進める。同claim tokenでの再送は冪等。policy停止の判定は外部呼出し前の`begin_provider_attempt`が担当 |
| `complete_mock_generation` | local-connected Queue Consumer | claim、期限、mock attempt 2件、固定comicのschema・generation由来asset IDを確認し、comic JSONとconsumed台帳状態を確定。Storage画像を保存しない |
| `mark_generation_enqueued` | Worker | Queue送信後にqueued jobの配送時刻を更新し、未配送再送までの待機を記録 |
| `list_generation_reconcile_candidates_v2` | Scheduled handler | 最大50件までgeneration IDとactionだけを返す。通常のcancel/expiry精算を先に返し、対象となる期限切れOpenAI saving jobを`recover-saving`、未配送queued jobを最後に返す |
| `claim_retention_cleanup` | 日次cleanup service | dueかつactive jobがないentryを最大10件claimし、15分lease・claim token・DB登録済み画像path snapshotを返す。Storage通信中はDB transactionを保持しない |
| `finalize_retention_cleanup` | 日次cleanup service | Storage削除成功後だけ実行する。lease/token・期限・active jobなし・claim時点と同じasset path集合を再確認して台帳をprivateへ移し、asset→job→entryを削除する。quota counterは変更しない |
| `fail_or_hold_generation` | Consumer / 定期照合 | `p_generation_id uuid`, `p_claim_token uuid`（queued jobは`null`）, `p_terminal_status text`（`failed` / `cancelled`）。未送信が証明できる場合だけreservationをreleaseし、結果不明はjob `unknown` / reservation `held`、結果既知は最大予約額を`consumed` |

- デッドロック防止のロック順序：`reserve_generation` RPCは、冪等性確認・枠確保・金額予約・job作成・pointer更新を1トランザクションで処理します。quota lockを取るreserve/claim/attempt/settlement RPCはpolicy用2整数advisory transaction lock→global total→global day→user day→entry→job→attemptの固定順序を守ります。削除受付はentry/jobだけをロックしてcancel flagを立て、同じtransaction内ではquotaを触りません。policy更新triggerも同じadvisory lockを取るため、運用者はpolicy変更を単独の短いtransactionで行い、すぐcommitします。
- 物理削除のfinalizeもpolicy advisory lock→owner advisory lock→entry→jobの順で処理します。期限切れ/削除済みentryにqueued / running jobがあればcleanup claimから除外し、Queue側の`fail_or_hold_generation`によるcancel・精算が終わるまでmetadataを保持します。
- APIはTurnstile検証前に`find_generation_receipt`を呼び、receiptがあれば返します。`null`の場合だけCAPTCHAを検証して、local-connectedでは`reserve_mock_generation`、live-demoでは`reserve_openai_generation`を呼びます。各wrapperはpolicy更新用lockを保持し、指定されたmockまたは固定OpenAI profileだけを既存予約RPCへ渡します。新規live-demo予約は、環境flag・OpenAI key・Queue・Turnstile・保存handler・復旧callbackの設定もそろわなければ拒否します。
- `find_generation_receipt`は有効な本人entryを確認し、既存jobの有無を返す読み取りRPCです。停止中も使え、日記の現在revision一致は要求しません。未登録キーは`null`、別entry/revisionで同じキーを使った場合は`IDEMPOTENCY_CONFLICT`、他人・削除済み・期限切れentryは`NOT_FOUND`です。`reserve_generation`も既存キーを返す前にentryの所有者・未削除・期限内を確認します。
- `reserve_generation`はWorker環境変数`GENERATION_ENABLED`を信頼した`p_generation_enabled`引数として受け取り、クライアントからは受け取りません。新しいjobではpolicy profileの`model_profile_json`と日記本文/revisionをsnapshotへ固定し、`is_mock`をprofileから明示します。RPCのJSONB結果はSQL側の`generation_id`・`status`・`status_url`で、API担当がHTTP `GenerationReceipt`の`generationId`・`status`・`statusUrl`へmapします。
- `claim_generation`のJSONBはQueue Consumerだけが読み、`generation_id`・`entry_id`・`owner_id`・`entry_revision`・`is_mock`・`input_snapshot`・`model_profile_snapshot`・`claim_token`・`deadline_at`を含みます。日記期限は全ロック取得後の時刻で再確認し、その時刻から15分のclaim期限を設定します。期限切れjobは自動再claimしません。
- `begin_provider_attempt`のJSONBは`attempt_id`・`generation_id`・`stage`・`call_index`・`mode`・`is_mock`です。claim期限・日記期限はquota・entry・job lock取得後の現在時刻で再検査します。scriptは1回、imagesはsnapshotの`max_image_calls`まで（未指定1、上限4）連番で開始できます。最初のimages attemptはscript成功後に限り、`generations.stage`を`script`から`images`へ同じtransactionで進めます。失敗後・結果不明・dispatch未確定の同じstageを再送せず、mockもattemptを台帳へ記録してAI providerへ渡しません。
- `finish_provider_attempt`はrunning job・一致するclaim token・reserved reservation・dispatch済みattemptを再確認します。外部送信はすでに済んでいるため、削除要求・日記期限・claim期限後でもknown resultとrequest IDを記録します。terminal job・古いtoken・精算済みreservationは変更しません。request IDはnullableかつ最大200文字、mockではnullです。
- `fail_or_hold_generation`は全ロック取得後の現在時刻でclaim期限を再確認し、queued / runningの未終端jobだけを扱います。non-mockの`dispatched` / `unknown` attemptが残ればjobを`unknown`、reservationを`held`にします。既知のnon-mock結果または確定したmock結果は予約最大額を`consumed`にし、外部未送信を証明できる場合のみ`released`へ変更します。releaseは予約時の`reserved_day`に対して各1回だけ行い、terminal job・古いclaim token・二重精算は状態やcounterを書き換えません。
- `get_generation_quota`はDB残数とpolicy由来の利用可否を内部JSONBで返します。HTTP APIは`profile_is_mock`などのpolicy情報を除外し、mode・queue・Turnstile・OpenAI key・flag・保存handler・保存復旧callbackの設定も合わせて`generationAvailable`を返します。実AI policyが初期停止中、必要な設定が欠けている場合、または保存系handlerの片方でも未注入の場合はfalseです。Cronの保存復旧は既存jobの保存専用処理なので、`GENERATION_ENABLED`とOpenAI keyの有無に依存しません。
- `complete_mock_generation`はQueue Consumerが固定fixtureを確定する専用RPCです。`complete_generation`や実AI/Storage保存serviceを代用せず、表示される画像URLは公開サンプルに限ります。
- canonical requestはAPI v1・`entryId`・`expectedRevision`のJSONB表現をUTF-8 SHA-256化した値で、`find_generation_receipt`と`reserve_generation`が同じprivate helperを使用します。JSON body、単価、profile ID、残り枠をRPC引数で受けず、本文・profileはDB正本から取得します。

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
  - `CallOptions`：中断用の`AbortSignal`、`generationId`、`callIndex`、許可された`modelProfile`と任意の`attemptHooks`を渡します。
  - `ScriptResult`：スキーマ検証済みの4コマ脚本データ。
  - `RenderedComic`：`page`画像1枚または`panels`画像4枚のバイナリデータに加え、プロバイダから取得できる`requestId`・`modelId`・トークン等の`usage`情報を含めます。
- アダプターの境界ルール
  - アダプター自身はDB・HTTPレスポンス・利用枠（quota）を直接操作しません。
  - `attemptHooks.begin(stage, callIndex)`は各外部呼出しの直前に台帳を開始し、完了後の`finish`へ既知結果または`unknown`と安全なrequest ID・usageを返します。画像Providerは4回を直列に行い、各画像SDKメソッドを呼ぶ前にbeginを完了させます。
  - 送信後timeoutや通信切断は`unknown`として保持し、provider SDKの自動再送を無効にします。成功HTTP応答後のJSON・スキーマ・画像デコード失敗は外部呼出し成功として台帳へ記録し、別のAPI呼出しに置き換えません。
  - 個人の日記・画像を扱うOpenAI SDK clientは`logLevel: 'off'`を指定し、`OPENAI_LOG`環境設定でrequest詳細が出ないようにします。
  - 保存service側が`RenderedComic`の画像をStorageへ保存して`assetId`に変換し、最終的な`ComicDocument`を組み立てます。
  - 画像bytesやBase64はアプリのHTTP JSON body / responseやDBの`comic_json`カラムへ埋め込みません。Providerと保存handler内部ではbinaryで受け渡し、保存後の画像はasset IDに対応する専用URLから配信します。
  - AIプロバイダが画像バイナリではなく一時URLを返す場合のダウンロード制約は、[OPERATIONS.md](OPERATIONS.md)のセキュリティ規則に従います。


## ローカル開発用の脚本サンプルAPI

`GET /api/v1/dev/script` は `MockScriptProvider` を呼び出します。Providerが
`docs/contracts/script.example.json` をimportし、既存の脚本用Zodスキーマで検証して `{ mock: true, script: { title, panels } }` を返します。
日記を受け取らない固定サンプル専用のAPIです。画像生成・保存・Queue・外部AI呼び出しは行いません。

利用条件は開発ビルド、`local-mock`モード、localhost / 127.0.0.1 / ::1です。
Originが指定されている場合は同一Originのみ許可します。認証は不要です。
既存の個人データAPIの認証条件は変更しません。条件外は404、不正な環境設定や
サンプルのスキーマ違反は一般化した503、レスポンスは `Cache-Control: no-store` です。

リポジトリで `pnpm dev` を実行し、表示されたポート（既定5173）で次を開きます。

```text
http://127.0.0.1:5173/api/v1/dev/script
```

サンプルJSONを編集すれば開発サーバーに取り込まれます。形式検証であり、
日記への忠実さや物語の品質までは検証しません。


### ScriptProviderのモック実装

`src/server/ai/script-provider.ts` に、API.md §10を具体化したサーバー内部の型を定義します。
共有の `ComicDocument` や既存HTTPレスポンスは変更しません。

- `DiarySnapshot`: 日記の `id`・`diaryDate`・`body`・`revision` の読み取り専用スナップショット。
- `ScriptResult`: `scriptSchema`から導出した `title` と4コマの `panels`。
- `CallOptions`: `signal`、`generationId`、`callIndex`（初回は1）、
  `modelProfile: { provider, modelId }`。モデル設定はサーバー側で選びます。
- `ScriptProvider.createScript(input, options)`: `Promise<ScriptResult>` を返します。

`MockScriptProvider` は入力本文に関係なく固定脚本を返し、外部通信・保存・利用枠操作を行いません。
中断済みのsignal、不正な固定脚本、未対応のモデル設定では例外を返します。
モデル設定は `mockScriptModelProfile`（mock / fixed-script-v1）だけを受け付けます。
このmodelProfileの形はモック段階の最小定義であり、本物のAIモデルの許可・予算検査の代用ではありません。

開発用GET APIは固定の架空日記と呼び出し設定をProviderへ渡します。
利用者の日記の受け付け、生成ジョブ登録、Queue、DB保存への接続は今回の対象外です。
結果の `mock: true` はHTTP側が付けます。将来は別のScriptProvider実装へ差し替えられます。


## 11. OpenAI白黒生成と保存受け渡し

### 固定profileとProvider

本番QueueのProviderはOpenAIに固定し、HTTP bodyでmodel・color mode・料金・呼出回数を指定できません。DBの`reserve_openai_generation` wrapperと`src/server/ai/openai-generation-profile.ts`はprofile全体を照合します。

- profile ID：`openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1`
- 脚本：Responses API、`gpt-4.1-mini-2025-04-14`、JSON Schema strict、`store: false`
- 画像：Images API、`gpt-image-2.5-flare`、1024×1024、`quality=low`、PNG、最大4回
- 画像生成は1コマ目を`images.generate`で作り、2〜4コマ目は1コマ目の画像を参照に`images.edit`で順番に作ります。APIへ文字を描かせず、captionとdialogueは既存Comic表示へ渡します。
- 脚本promptは日記内の命令を実行せず、原文にない事実・感情・直接発言を追加しないよう指定します。画像の主人公に使う短い黒髪と黒いパーカーは物語の事実ではなく、全コマで外見をそろえるための架空アバター表現です。
- 脚本modelは公式model pageにdeprecatedとshutdown予定日`2027-01-14`が記載されています。PRでは既存profileを維持し、長期運用前に移行先と品質を再評価します。

OpenAI SDKの自動再送は無効です。SDK responseから安全なrequest ID・usageを受け取り、4xx拒否は`failed`、timeout・ネットワーク断・5xxは結果不明として`unknown`に記録します。HTTP成功を受けた後のJSON・schema・画像デコード失敗も外部APIの成功記録を残し、再送しません。SDKの`logLevel`は`off`です。

### live-demoの受付から保存まで

既存の`POST /entries/:entryId/generations`を使います。受付・queue・consumerは次の順で動きます。

1. JWTを検証し、owner・entry・revision・idempotency keyを確定します。
2. `find_generation_receipt`で既存receiptを確認します。既存なら新しいCAPTCHA検証・予約・AI呼出しをせず同じreceiptを返します。
3. 新しい受付は生成用Turnstileを検証し、`reserve_openai_generation`でDB policy lock下のOpenAI profile・日記snapshot・最大費用枠を原子的に予約します。
4. Queueへは`{ generationId }`だけを送ります。Consumerはclaim後にsnapshotを検証し、script 1回、image 1〜4の各API呼出し直前に`begin_provider_attempt`、既知結果直後に`finish_provider_attempt`を呼びます。
5. scriptと4枚の画像が検証済みになった後、`mark_generation_saving`でstageを`saving`へ進めます。これは画像保存や成功確定を行いません。
6. `mark_generation_saving`の後、保存handlerはscriptと保存taskの再開情報をdurableに記録し、画像をprivate Storageへ保存してassets・`comic_json`を登録、完了を確定します。DBの完了確定後だけgeneration IDと`succeeded`を返します。

`unknown`のattemptは自動再実行せず、予約枠をheldにします。保存handlerがthrowするか不正な結果を返した場合、Consumerは`saving-pending`としてQueue messageをackし、jobは`running` / `saving`のまま残します。Cronはdurableに保存済みの情報から保存復旧callbackを呼び、AIは再実行しません。durableな保存情報を作る前にhandlerが失敗するなど復旧データが足りない場合、保存担当が安全に失敗または取消を確定します。削除・cancel・entry期限切れのjobは保存復旧より通常の取消・期限精算を先に行います。二重配送・claim失効・削除や期限との競合で外部呼出しを重ねないよう、Queue messageにはIDのみを載せ、各provider callをDB attempt台帳で囲みます。Queueメッセージ、アプリのJSON API body/response、`comic_json`へ画像bytesやBase64を埋め込みません。Provider・保存handler内部ではbinaryで受け渡し、画像配信はasset ID用の専用URLを使います。

### 保存担当が接続するhandler

`src/server/generation-save-handler.ts`の`SaveGeneratedComic`がConsumerから保存担当への受け渡し型です。入力は`generation`（generation / entry / owner ID、revision、日付、claim token、期限）、`profileId`、検証済み`script`、4枚の`rendered` panel bytesとMIME、各providerのrequest ID・usageです。画像metadataは4件・順番・profile modelをConsumerで再検証します。`SaveGeneratedComicContext`はそのQueue実行のWorker environmentと、14分またはclaim期限の早い方で中断される`AbortSignal`を渡します。保存handlerは再起動後にも続けられるよう、script・asset/task情報を早期にdurable保存し、同じgeneration IDに対して冪等に処理します。保存前のメモリ上の画像bytesがworker再起動後も保持される保証はありません。必要な画像がdurable保存される前に失われて復旧できない場合は、安全に失敗または取消を確定します。

```ts
const saveGeneratedComic: SaveGeneratedComic = async (input, context) => {
  // 1. claim / owner / entry revision / deadlineを確認
  // 2. script・保存taskの再開情報をdurableに保存
  // 3. input.rendered.panelsをprivate comics bucketへ保存し、asset metadataを登録
  // 4. scriptとasset IDでcomic_jsonを作り、server-only completion RPCでsucceeded確定
  // 5. 保存とDB完了確定が両方済んだ場合だけresolveする
  await savePrivateAssetsAndCompleteGeneration(input, context);
  return { generationId: input.generation.generationId, status: 'succeeded' };
};
```

`savePrivateAssetsAndCompleteGeneration`は説明用の仮名で、現repositoryにはまだ実装されていません。`mark_generation_saving`は実装済みですが、実画像のStorage保存・assets登録・実生成用のsucceeded確定RPCは未実装です。保存handlerがthrowする、またはgeneration ID/statusが契約に合わない場合はConsumerが`GenerationSavePendingError`として扱い、Queueをackして`stage=saving`を維持します。失敗をterminal化せずAIも再実行しません。

`RecoverGeneratedComic(generationId, { environment, signal })`は保存taskをIDで再開する注入callbackで、結果は`{ generationId, status: 'pending' | 'succeeded' | 'failed' | 'cancelled' }`です。復旧処理は保存担当がdurableに保持したscript/asset/task情報と既存generation IDから続け、AI providerを呼びません。復旧側でowner・保存専用lease・期限・削除/cancelを再確認し、完了または復旧不能時の安全な終端失敗・取消をDBへ確定します。`pending`は`stage=saving`を維持します。これは保存担当が実装する責務で、現repositoryには復旧handler本体も未実装です。

```ts
const recoverGeneratedComic: RecoverGeneratedComic = async (generationId, context) => {
  // generation IDでdurableな保存taskを開き、保存だけを再開する。AI providerは呼ばない。
  return resumePrivateSaveAndFinalize(generationId, context);
};
```

`resumePrivateSaveAndFinalize`も説明用の仮名です。handlerを接続するWorker entrypointは`src/server/index.ts`の`createWorker({ saveGeneratedComic, recoverGeneratedComic })`です。default exportでは両方とも未設定です。新規実AI生成には両handlerの注入を必須とし、どちらかが未設定ならfail closedにします。

### 実効ready条件

- `/config.generationAvailable`はlive-demoで、新規生成用の`GENERATION_ENABLED=true`、サーバー側`OPENAI_API_KEY`、Queue、許可hostnameを伴うTurnstile secret、保存handler、復旧callbackがそろった場合だけtrueです。keyやsecretはブラウザ設定へ出しません。default exportではhandlerが両方未設定のためfalseです。
- `GET /me/quota.generationAvailable`はこれらの実行設定に加え、DB policyがenabled、固定profileと予算・全体枠・ユーザー枠が利用可能であることを確認します。画面はconfigとquotaの両方が利用可能な場合だけ「4コマにする」を有効にします。
- live-demoの保存復旧用Cronは`recoverGeneratedComic`が設定されていれば、`GENERATION_ENABLED=false`またはOpenAI API keyなしでも既存のeligibleなsaving jobを回復できます。Cronは取消・削除・期限切れjobの通常精算を先に行い、次に期限切れOpenAI saving jobの復旧、最後に未配送jobのenqueueを行います。新しいAI生成は開始しません。
- initial DB policyは停止、全体枠・総予算は0です。共有DB migrationを適用していないため、実環境でのready状態・課金品質・利用可能なアカウント権限は未確認です。実AI利用は通常開発やCIでは行いません。

### ローカルのProvider確認

`GET /api/v1/dev/script`は架空固定脚本だけを返し、AIを呼びません。読み取り専用のCLI確認も外部送信しません。

```sh
mise exec -- node --experimental-transform-types scripts/generate-script-openai.ts
mise exec -- node scripts/render-comic.ts
```

`generate-script-openai.ts`は`--generate`が指定された場合だけOpenAIへ脚本を送り、既定の出力はgitignore対象の一意な`generated/openai-scripts/<uuid>.json`です。`render-comic.ts --generate`は開発用`POST /api/v1/dev/openai-comics`を呼びます。このローカル専用routeはlocalhost・development build・`local-mock`に限り、`OPENAI_IMAGE_ENABLED=true`と`OPENAI_IMAGE_BUDGET_APPROVED=true`の両方が必要です。これはliveの予約台帳を使わず、最大4回の実AI画像呼出しは課金対象になり得ます。プレビューはWorker memoryに15分保持し、永続保存しません。実生成を使う場合も、別途の課金承認後に架空fixtureだけを使ってください。

fixture `docs/contracts/script.example.openai.generated.json`と`docs/contracts/script.example.txt`は架空データです。実日記・実生成結果を`docs/`やGitへ保存しないでください。

参考：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[gpt-image-2.5-flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)、[Images API guide](https://developers.openai.com/api/docs/guides/image-generation)。
