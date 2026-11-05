# HTTP APIと共通契約v1（API）

> エンドポイント共通プレフィックス：`/api/v1`
> 以下はフロントエンド・バックエンド・DB・AIアダプター間の実装契約です（文書作成時点では未実装）。

### 初期基盤の実装範囲

localhost限定のモックで下記HTTP APIを実装しています。`/config.dataMode`で画面が認証・保存方式を選び、モードの判定はサーバーが行います。`generationAvailable`はこの基盤ではlocal-mockだけtrueです。

モックのBearerは`mock:<ランダムUUID>`で、ブラウザには仮セッションIDだけを保存します。`captchaToken`は空文字です。本物のJWT・Turnstileとは互換にせず、開発ビルドかつloopbackへの要求だけで許可します。生成は固定fixtureを即時確定し、Queue・実AIは呼びません。`mock: true`を生成結果へ付けます。画像URLは公開の架空サンプルであり、Storageの署名URLではありません。

以降の実認証・DB・Queue・期限削除等の記述は後続の実装契約です。モックは再起動で消える一時メモリで、実環境への安全性を検証したものではありません。

---

## 1. 共通規則

- データ形式
  - 文字コードはUTF-8のJSON、プロパティ名は`camelCase`。
  - 各種IDはすべて`UUID`形式。
  - 日時はUTCのISO 8601形式（例：`2026-10-27T12:00:00Z`）、日記の日付（`diaryDate`）は`YYYY-MM-DD`形式。
  - 定義されていない未知のプロパティが特権項目へ紛れ込むのを防ぐため、リクエストはすべてZodのstrict schemaで検証し、未知のキーがあれば拒否します。
- 認証と所有者判定
  - 保護されたAPIには`Authorization: Bearer <Supabase access token>`ヘッダーを付与します。
  - サーバー側でJWTの「署名・issuer・audience・有効期限・`sub`（ユーザーID）」を検証します。
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

### ステータスコードの共通ルール

- 404 Not Found：他人のデータID、削除済みID、存在しないIDへのアクセスは、存在有無を推測されないよう一律で`404`を返します。
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

### テーブル設計

| テーブル名 | 主なカラム | 主な制約・役割 |
|---|---|---|
| `public.entries` | `id`, `owner_id`, `create_request_id`, `diary_date`, `body`, `revision`, `latest_generation_id`, `consent_version`, `created_at`, `updated_at`, `deleted_at`, `expires_at` | PK `id`、`UNIQUE(owner_id, create_request_id)`、本文長・revisionのCHECK制約 |
| `public.generations` | `id`, `entry_id`, `owner_id`, `entry_revision`, `idempotency_key`, `request_hash`, `input_snapshot`, `model_profile_snapshot`, `claim_token`, `deadline_at`, `status`, `stage`, `comic_json`, `error_code`, `created_at`, `updated_at`, `enqueued_at`, `started_at`, `completed_at`, `cancel_requested` | `UNIQUE(owner_id, idempotency_key)`、`status`のCHECK制約、entry所有者との整合性保証 |
| `public.assets` | `id`, `generation_id`, `owner_id`, `object_path`, `media_type`, `byte_size`, `width`, `height`, `created_at` | `UNIQUE(object_path)`、許可MIMEタイプ、ファイルサイズ上限の制約 |
| `private.generation_policy` | `id=1`, `enabled`, `user_daily_limit`, `global_daily_limit`, `global_total_limit`, `budget_micro_usd`, `model_profile_json` | 初期値は`enabled=false`、全体枠/予算`0`。管理者のみ操作可能 |
| `private.quota_counters` | `scope`, `subject`, `day_key`, `count`, `committed_micro_usd` | `(scope, subject, day_key)`の一意制約。並行予約時に行ロックして集計 |
| `private.reservations` | `generation_id`, `owner_id`, `reserved_day`, `max_cost_micro_usd`, `state`, `created_at` | `UNIQUE(generation_id)`。`state`は`reserved` / `consumed` / `held` / `released` |
| `private.provider_attempts` | `generation_id`, `stage`, `call_index`, `state`, `request_id`, `started_at`, `finished_at` | `UNIQUE(generation_id, stage, call_index)`。AIモデルの重複呼び出しを防止 |

- 所有者とスキーマ保護：`owner_id`は検証済みJWTの`sub`から設定し、`entry`・`job`・`asset`の間でも所有者が一致することを照合します。`auth.users`はSupabase管理とし、`private`スキーマは外部Data APIへ公開しません。
- 主なインデックス：`entries(owner_id, diary_date, id)`、`generations(owner_id, created_at)`、`generations(status, created_at)`、`assets(generation_id)`。
- スナップショットとポインタ更新：生成予約時点の日記本文とモデル設定をsnapshotカラムへ固定し、`entries.latest_generation_id`を更新します（後から古いジョブが完了しても、新しいポインタを上書きしません）。

### サーバー専用RPC（ストアド関数）一覧

| RPC名 | 呼び出し元 | 処理内容・保証する条件 |
|---|---|---|
| `create_entry` | Worker（Supabase secret keyを使うclientのみ） | `actorId`は検証済みJWT由来。同一`createRequestId`は冪等に処理し、下書き件数上限と本文を検証 |
| `update_entry` | 同上 | 所有者、`revision`の一致、進行中（active）ジョブが無いことを検査して更新 |
| `request_entry_deletion` | 同上 | 所有者確認、日記の論理削除、進行中ジョブへの`cancel_requested`設定 |
| `reserve_generation` | 同上 | 所有者・同意・`revision`、冪等性、ユーザー枠/全体枠、予算金額を1トランザクションで原子的に検査・予約 |
| `claim_generation` | Queue Consumer | `queued`状態のジョブだけを`running`へ遷移させ、`claimToken`を発行 |
| `begin_provider_attempt` | Queue Consumer | `claimToken`の一致と同一`(stage, call_index)`が未実行であることを検査し、`dispatched`を記録 |
| `complete_generation` | Queue Consumer | `claimToken`、未削除状態、アセット数と所有権を検証し、生成結果を確定 |
| `fail_or_hold_generation` | Consumer / 定期照合 | 外部AI呼び出し済みなら保守的に`held` / `consumed`を維持。外部未送信が確認できた場合のみ枠を`release`（返却） |

- デッドロック防止のロック順序：`reserve_generation` RPCは、冪等性確認・枠確保・金額予約・ジョブ作成・ポインタ更新を1トランザクションで処理します。カウンター行を作成した後、必ず「全体policy/total → 全体day → ユーザーday → entry/job」の固定順序で行ロックを取得し、キャンセル・解放処理でも同じロック順序を守ります。

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


### Gemini脚本生成のローカル実験

`GeminiScriptProvider`は公式SDKの `models.generateContent` を使い、
`gemini-3.5-flash-lite`へ日付と本文を送ります。モデルはサーバー側に固定します。
JSON Schemaで4コマの出力形式を指定し、既存Zodスキーマで文字数と番号も検証します。
タイムアウト120秒、自動再試行なし、最大出力4096トークンです。
不完全な終了、空出力、不正JSON、スキーマ違反はエラーにします。
プロバイダの生エラーや日記本文はログへ出しません。

最初にAI Studioで対象プロジェクトがFreeであり、モデルの無料枠と利用上限を確認します。
無料枠のキーかどうかをコードから判定することはできません。
検証には個人情報のない架空の日記を使ってください。

`.dev.vars`の既存のキー設定に加えて、実験を行うときだけ次を設定して開発サーバーを再起動します。

```dotenv
GEMINI_API_KEY="自分のキー"
GEMINI_SCRIPT_ENABLED="true"
```

`APP_ENV=development`、`DATA_MODE=mock`、`AI_MODE=mock`、`GENERATION_ENABLED=false`のまま使います。
`GEMINI_SCRIPT_ENABLED`省略時は実験APIを停止します。
公開環境の実AI有効化とは別の、ローカル比較実験用の入口です。

```powershell
$payload = @{
  diaryDate = '2026-10-29'
  body = '架空の日記。図書館で本を読んだ。帰り道で猫を見かけた。'
} | ConvertTo-Json
$result = Invoke-RestMethod -Uri 'http://127.0.0.1:5173/api/v1/dev/gemini-script' `
  -Method Post -Headers @{ 'X-Dev-Gemini' = '1' } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
$result | ConvertTo-Json -Depth 10
```

実行するとGemini APIへ1回送信します。成功時は `{ mock: false, modelId, script }` を返します。
日記や生成結果のDB保存、画像生成はこの入口では行いません。
開発ビルド・local-mock・loopbackホスト限定、Origin指定時は同一Originのみです。
既存の固定サンプルGET APIは引き続き利用できます。
ローカルWorker内で同時1件、起動中5試行までに制限します。このカウンターは再起動やHMRでリセットされ、
クラウド側の予算制限の代わりにはなりません。失敗も1試行として数え、429や通信中断を自動再送しません。
実験後は `GEMINI_SCRIPT_ENABLED=false` に戻してください。


## ローカル開発用：脚本から4コマ画像を生成

`POST /api/v1/dev/openai-comics` は検証済み脚本を受け取り、OpenAI Images APIで1コマずつ順に生成する開発用API。
localhostの開発ビルド、local-mockモード、同一Origin限定。通常の生成API・Queue・DB・Storageには接続しない。
既存の脚本生成プロンプトは変更しない。

- 使用モデル：`gpt-image-2.5-flare`、1024×1024、quality=low、PNG。OpenAI APIの利用料金が発生する。
- 実行前に課金設定・利用可能モデル・料金と予算の承認を確認する。実装時には実AIの呼び出しは行っていない。
- `.dev.vars` の既存 `OPENAI_API_KEY` に加え、予算承認後に `OPENAI_IMAGE_ENABLED="true"` と `OPENAI_IMAGE_BUDGET_APPROVED="true"` を設定し、開発サーバーを再起動する。既定は無効。キーを `VITE_*` に置かない。
- ヘッダー `X-Dev-OpenAI: 1` が必要。本文は `{ "script": { "title": "...", "panels": [...] } }`。既存のscriptSchemaで検証する。
- 主人公は試作用の「白い二頭身の猫・黒いパーカー」固定。1コマ目を2〜4コマ目の外見参照として送る。外見の完全一致は保証されない。
- 文字は画像に描かせず、HTMLプレビュー側でcaption/dialogueを表示する。4枚を縦に並べる方式で、結合PNGの出力ではない。
- 同時1件・Worker起動中2試行まで。SDKの自動再送は無効。1リクエスト最大4回の画像生成で、後続コマへの参照画像入力にも料金がかかる。再起動で制限は戻るため、実予算の上限管理の代用にはしない。
- 画像はPNG/JPEG/WebPのMIMEと先頭バイトを検証し、1枚8MiB・合計16MiBまで。Base64をJSONへ返さない。
- 成功時は200、生成中の失敗は503。`status`, `previewUrl`, `panels[].url` を返す。失敗時は`error.code`, `failedPanel`, `retryable: false`も返す。成功済み画像は保持する。結果不明時はOpenAI API Platformの利用状況を確認し、むやみに再送しない。
- プレビューと画像は生成終了から15分間、Workerメモリにだけ保持する。再起動・期限切れで消える。永続保存・公開用途には使用しない。

PowerShellの実行例（課金と予算の確認・承認が済んだ場合のみ）：

```powershell
# 保存済みの脚本JSONを利用。ファイルの中身はtitleとpanelsを持つ脚本そのもの。
$script = Get-Content './docs/contracts/script.example.generated.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$comicPayload = @{ script = $script } | ConvertTo-Json -Depth 10
$comic = Invoke-RestMethod `
  -Uri 'http://127.0.0.1:5173/api/v1/dev/openai-comics' `
  -Method Post `
  -Headers @{ 'X-Dev-OpenAI' = '1' } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($comicPayload)) `
  -TimeoutSec 600 `
  -SkipHttpErrorCheck
$comic | ConvertTo-Json -Depth 10
'http://127.0.0.1:5173' + $comic.previewUrl
```

最後に表示されるURLをブラウザで開く。既に`$result.script`に生成済み脚本がある場合は、上の`$script`への代入を`$script = $result.script`に置き換えられる。
生成だけを試す場合は既存の`docs/contracts/script.example.json`も使用可能。
料金・利用可能モデルは実行時に[公式の料金表](https://developers.openai.com/api/docs/pricing)で再確認する。


### 保存済みのGemini脚本から生成するコマンド

開発サーバーを既定ポート5173で起動したまま、別のターミナルで実行します。
既定の入力は `docs/contracts/script.example.generated.json` です。

```powershell
# まず入力検証のみ。AIは呼びません。
node scripts/render-comic.ts

# 画像生成の予算承認・有効化後、最大4回の画像生成を実行します。
node scripts/render-comic.ts --generate

# 別の脚本JSONも指定できます。
node scripts/render-comic.ts docs/contracts/script.example.json --generate
```

APIキーはWorkerの環境変数で管理します。コマンドは検証済み脚本だけをローカルAPIへ送り、
画像を含むJSONを出力せずにプレビューURLと取得コマ数を表示します。
部分失敗時も取得できたプレビューURLを表示し、終了コード1で終了します。
自動再送は行いません。画像の品質・所要時間・実費は実モデルによる検証が必要です。


脚本はGeminiで生成し、保存したJSONをOpenAIの画像Providerへ渡します。
画像Providerの1コマ目は `images.generate`、2〜4コマ目は1コマ目のPNGを参照する
`images.edit` を使います。Gemini用の画像生成フラグでは有効化されません。
旧Gemini画像アダプターは既存コードとして残っていますが、開発APIからは呼び出しません。

### OpenAI版の脚本生成コマンド（Gemini版とは別実装）

`scripts/generate-script-openai.ts` は開発サーバーを経由せず、Node.jsからOpenAI Responses APIを1回呼ぶ比較用コマンドです。
既存のGemini Provider・APIは変更しません。モデルは `gpt-4.1-mini-2025-04-14` 固定。
Gemini版の指示・JSON Schemaを作成時点で複製し、主人公だけ人間の大学生に指定しています。
今後片方のプロンプトを変更する場合、比較条件の差として記録してください。
Structured Outputsの後に共通Zodで検証し、完成した脚本のみをJSONに書き込みます。
120秒、最大出力4096トークン、SDK自動再送なし、`store: false`。本文や生エラーは表示しません。
`store: false` はResponsesの保存設定であり、サービス全体のデータ保持を保証するものではありません。

既存の `.dev.vars` の `OPENAI_API_KEY` をNodeの `--env-file` で読み込みます。環境変数の追加は不要です。
Worker用の画像・Geminiの有効化フラグとは独立し、`--generate` がこのコマンドの送信スイッチです。
費用確認後、リポジトリのルートで実行します。日記TXTは本文だけのUTF-8ファイルです。

```powershell
# 入力確認のみ。APIへの送信・出力ファイル作成はしません。
node scripts/generate-script-openai.ts --date 2026-10-29

# APIへ1回送信し、OpenAI専用のJSONへ保存します。
node --env-file=.dev.vars scripts/generate-script-openai.ts --date 2026-10-29 --generate

# 生成した脚本を使ってOpenAIで漫画を生成します。こちらはpnpm devが必要です。
node scripts/render-comic.ts docs/contracts/script.example.openai.generated.json --generate

# 別の日記・出力先も指定できます。
node --env-file=.dev.vars scripts/generate-script-openai.ts docs/contracts/script.example.txt docs/contracts/script.openai.second.json --date 2026-10-29 --generate
```

日記の既定入力は `docs/contracts/script.example.txt`、出力は `docs/contracts/script.example.openai.generated.json`。
日付の省略時は日本時間の当日。比較時は同じ本文と日付を指定してください。
既存ファイルは送信前に拒否し、上書きしません。失敗時は空・不完全な出力ファイルが残る場合があります。
API利用状況を確認し、ファイルを手動で整理するか別名を指定します。画像生成は自動開始しません。
既存の `script.example.generated.json` を使うGemini脚本経路はそのままです。
現時点で漫画のCLIが接続する先はOpenAI画像APIです。Geminiだけで脚本と画像を生成する経路はこの追加には含みません。

参考：[OpenAI公式 Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、
[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)。


### Geminiだけで日記から漫画を生成する別コマンド

`node --experimental-transform-types --env-file=.dev.vars scripts/generate-comic-gemini.ts --generate`で、Geminiの既存脚本Providerと画像Providerを順に呼び出します。
OpenAI版とは別実装で、開発サーバーを経由せず、生成結果をローカルファイルへ保存します。
既定は入力確認のみ。費用確認後に有効化フラグと`--generate`を指定します。
詳しい準備・出力・失敗時の手順は[GEMINI_LOCAL.md](GEMINI_LOCAL.md)を参照してください。

### OpenAIカラー漫画の比較用コマンド

白黒版の `scripts/render-comic.ts` と `OpenAIImageProvider` を残し、
カラー専用の `scripts/render-comic-color.ts` と `OpenAIColorImageProvider` を追加。
同じモデル・解像度・品質で、フルカラーの彩色と全コマの色の統一を指示します。
人間の大学生という主人公設定、1コマ目を後続の参照画像にする方式は白黒版と同じです。
実際の彩色や外見の一致は実生成で確認が必要です。

```powershell
# pnpm devを起動した状態で、別のターミナルから入力確認
node scripts/render-comic-color.ts docs/contracts/script.example.openai.generated.json

# カラー漫画を生成（最大4回の画像生成で料金が発生）
node scripts/render-comic-color.ts docs/contracts/script.example.openai.generated.json --generate

# 同じ脚本の白黒版
node scripts/render-comic.ts docs/contracts/script.example.openai.generated.json --generate
```

入力を省略すると白黒版と同じ `docs/contracts/script.example.generated.json` を使用。
カラー版は `POST /api/v1/dev/openai-color-comics` に送信し、カラー専用URLでプレビューします。
白黒・カラーで各々同時1件・起動中2試行までです。合計では最大4試行となります。
既存の `OPENAI_API_KEY`、`OPENAI_IMAGE_ENABLED`、`OPENAI_IMAGE_BUDGET_APPROVED` を共用し、新しい環境変数は不要。
ローカル限定・15分間のメモリ保存・部分失敗の回収・自動再送なしの条件も白黒版と同じです。
コード変更や再起動で以前のプレビューは失われる場合があります。画像の永続保存は行いません。
Geminiの生成スクリプトと脚本JSONは変更していません。
