# 構成と設計判断（ARCHITECTURE）

> 2026-10-27に採用した実装方針です。全体の構成・共通型・公開条件を先に揃え、通常の開発はモックで進めます。

以下の実装状況はPR#23までの未マージStackの実装基準HEAD`f255783`（この文書更新commitより前）を指し、`main`にはまだ統合されていません。詳細は[PLAN](PLAN.md)を参照してください。

---

## 1. システム構成と各層の役割

```text
React PWA ─ Supabase Auth（匿名サインイン・トークン更新）
    └─ Hono API / Cloudflare Workers（JWT検証・所有者確認）
         ├─ PostgreSQL（読み取りは利用者JWT + RLS、書き込みはサーバー専用RPC）
         ├─ private Storage（画像保存・短命の署名URL発行）
         └─ Queues（job IDのみ送信）→ 同じWorkerのConsumer → AI生成 → 保存
Scheduled handler（定期実行）→ 未配送jobの再送・停止状態の照合・保存期限/削除処理
```

### 採用技術スタック

- フロントエンド：React + TypeScript + Vite、React Router、Tailwind CSS、`vite-plugin-pwa`
  - 非公開のシングルページアプリケーション（SPA）に絞り、SSR（サーバーサイドレンダリング）・別建てのAPIサーバー・ORM・D1/R2の併用は導入しません。
- バックエンド / 配信：Hono（HTTPルーティング）+ Cloudflare Workers（実行環境）
  - 画面とAPIは同一オリジン（同一ドメイン）で配信します。
  - `/api/*`への存在しないパスはJSONの404を返し、それ以外の画面パスはSPA fallback（`index.html`）へ振り分けます。
- 認証・データベース・ストレージ：Supabase（Auth / PostgreSQL / Storage）+ `supabase-js` + SQL migration
  - データのクラウド保存と、匿名ユーザーの端末間復旧は別問題として切り分けます。
- 入力検証・テスト・開発基盤：
  - 外部からの入力はすべてZodのstrict schemaで検証し、そこからTypeScriptの共通型を導出します。
  - lint/formatはoxlint・oxfmtを採用し、設定を最小限に揃えます。テスト・CIにはVitest・Playwright・pnpm・GitHub Actionsを使い、Node.jsとpnpm`12.11.2`のバージョンは`mise`で管理します。
- 責務の分離（保存サービスとAIアダプター）：
  - 保存service：生成された画像の検証・Storageへの保存・`assetId`の採番を担当します。
  - AI adapter：純粋にAIモデルの呼び出しだけを担当し、DB・認証・利用枠（quota）・HTTPレスポンスは直接操作しません。
  - 各層をつなぐ詳細な契約は[API.md](API.md)で定義します。

### ディレクトリ構成

```text
src/
 ├─ client/   { app, features, components, lib }         # フロントエンド（React）
 ├─ server/   { routes, middleware, services, repositories, ai, jobs } # バックエンド（Hono / Workers）
 └─ shared/   { schemas, types, fixtures }               # 画面・サーバー共通の型とモックデータ
public/                                                  # 静的ファイル（※公開サンプル以外の個人データは置かない）
supabase/
 └─ { migrations, tests }                                # DBスキーマ定義とRLS/RPCテスト
```

### 実装コードの責務境界

- `client/app/App.tsx`はアプリ共通枠・設定取得・画面離脱保護、`app/routes.tsx`はルートと利用可否の表示を担当します。ホーム固有の取得・表示は`features/home/`に置きます。
- 日記の新規作成と編集では`DiaryDateField`・`DiaryBodyField`と日付書式を共有します。利用枠は`useGenerationQuota`で取得し、新規画面だけ再取得時にloadingへ戻す差を明示します。
- 記録のURL状態は`librarySearch.ts`、日付計算は`libraryCalendar.ts`、取得範囲の走査は`libraryCoverage.ts`、取得中の状態とキャンセルは`useLibraryEntries.ts`が担当します。表示のページ数とAPIのcursorは別に扱います。
- 詳細の編集は`useEntryEditor`、生成中の状態取得は`useGenerationPolling`、操作メニューは`DetailToolbar`、状態カードは`GenerationStatusCard`へ分離します。編集・生成・削除の排他用refは詳細画面内で共有し、別々の操作ロックを作りません。
- `client/lib/api/`は通信基盤、日記操作、生成受付・再確認、画像URL取得で分けます。既存の`lib/api.ts`からのexportは維持し、作成・生成の冪等性キーと保存形式も変更しません。
- サーバーの`http.ts`はHTTPエラーとサイズ制限付き本文読取、`repositories/mock-service.ts`はモックの日記作成・一覧・枠確認・生成を担当します。実接続との振り分けと認証の順序は`server/app.ts`に残します。
- SupabaseのURL・キー検証は`supabase-config.ts`、生成行の状態変換は`generation-row.ts`へ集約します。利用者用・RPC専用・Storage削除専用のクライアントは分け、所有者と最新／履歴生成の関連確認は呼出元で行います。

### 初期読み込みと認証SDK

認証SDKはliveモードと公開設定を確認した後、セッション確認・明示的な登録が必要になった時点で読み込みます。初期化Promiseを共有し、読み込み・初期化失敗をセッションなしとして扱わず、匿名アカウントの自動作成や保存済み認証情報の削除は行いません。

画面のコードと全静的JS/CSSのPWA事前キャッシュは維持します。SDKの分離は初期の解析・実行量を減らすもので、PWAの取得総量を大きく減らすものではありません。liveの初回セッション確認時にはSDKチャンクの取得が1回必要です。PWA成果物の入口JSは`index.html`から特定します。

共有の日付関数は`shared/date.ts`に置き、既存の`shared/schemas.ts`からのexportも維持します。フォーマッターは再利用し、呼出時の現在時刻からJSTの日付を求めます。

---

## 2. 非同期生成の処理フローと境界

AIによる漫画生成は時間がかかるため、HTTPリクエスト内で直接待たず、Cloudflare Queuesを用いた非同期処理で行います。

1. 受付と枠予約（HTTP API側）
   - 認証・同意状態・所有者・`revision`（改訂番号）・冪等性キー（`Idempotency-Key`）・CAPTCHAを検証します。
   - PostgreSQLの1トランザクション内で、生成枠の予約と`queued`状態の生成ジョブ作成を同時に行います。
2. キューへの投入（HTTP API → Queue）
   - Queueには`{ generationId }`だけを送信し、クライアントへ即座に`202 Accepted`を返します。
   - 万が一Queue送信に失敗してもDB上のジョブは保持し、Scheduled handler（定期実行）で未配送ジョブを再送します。
3. ジョブの取得と重複防止（Queue Consumer）
   - Consumerは`queued`状態のジョブを原子的（アトミック）に取得（claim）し、発行された`claimToken`を使って外部AI呼び出しの開始・完了を管理します。
   - Queueの仕様で同じメッセージが重複配信されても、AIを二重に実行しません。
4. AI呼び出しと保存（Consumer → AI / Storage / DB、実AI経路は未接続）
   - 外部AIを呼ぶ直前に、全体停止や日記の削除要求がないか再確認し、試行状態を`dispatched`として記録します。
   - AIから返った脚本と画像を検証した後、StorageとDBへ保存します。
5. 中断・障害時の扱い
   - 外部AIへリクエストを送信した後に処理が中断した場合は、[用語集](../README.md#glossary)の`unknown`として記録・照合します（`running`状態のジョブを自動的に`queued`へ戻して再実行することはしません）。
   - Storageへの画像保存後にDB更新だけが失敗した場合は、AIを再実行せず保存済みの既存画像から完了確定を再試行します。

### キューとタイムアウトの初期設定値

- Queue設定：1本、初期値は`batch size: 1`・`concurrency: 2`。
- 時間制限の目安：AIプロバイダ呼び出しのtimeoutは120秒、ジョブ全体の完了目標は10分、進行が15分停止したものは`unknown`候補とします。
- 定期処理（Cron）：`* * * * *`は未配送jobの再送・期限照合、`0 15 * * *`（UTC）はJST 0時の期限削除です。Cron文字列でhandlerを分け、dailyは`local-connected` / `live-demo`に限り個人データへ接続します。1回に最大10entryを処理します。
- ※ 開発内部でのAIモデル比較実験は同期処理で行っても構いませんが、その実験用コードをそのまま外部へ公開しません。

---

## 3. 動作モードとPWAキャッシュ方針

### サーバーの動作モード（4種類）

<a id="mode-matrix"></a>

設定検証、local-mock、preview-sample、liveモードのJWT検証と日記CRUD接続は実装済みです。local-connectedとlive-demoでは日記一覧・詳細・作成・編集・論理削除をSupabase DBへ接続します。local-connectedはgeneration受付・quota・status読取・Queue・未配送再送・期限照合を固定mockで実行します。`/assets/:id/url`は本人の有効なmock jobだけに公開サンプル画像を返し、Storage署名URLを発行しません。期限削除serviceを日次Scheduled handlerへ接続しました。`local-connected`と`live-demo`は実行対象、`sample`・malformed modeは個人DB/Storageへ接続しません。live-demoの新しい実AI生成は未実装のため常に停止し、実AI・Storageのprivate画像保存と署名URLも未接続です。`APP_ENV`は実行環境、`DATA_MODE`は保存・認証の方式、`AI_MODE`は生成adapterを選びます。`GENERATION_ENABLED`は実AI呼び出しの許可で、mock生成ではfalseのまま使います。preview-sampleでは生成受付を無効にします。過去の一部ローカル結合確認と未確認項目は[README](../README.md)を参照してください。

| モード | APP_ENV | DATA_MODE | AI_MODE | GENERATION_ENABLED | 挙動 |
|---|---|---|---|---|---|
| `local-mock` | `development` | `mock` | `mock` | `false` | localhost限定の仮ユーザー・仮保存・固定漫画 |
| `local-connected` | `development`または`staging` | `live` | `mock` | `false` | 開発Supabase・本物Auth・Queue経由の固定mock漫画で結合確認。Queue/Turnstile secretsがなければ新規受付は停止 |
| `preview-sample` | `staging`または`production` | `sample` | `mock` | `false` | 架空サンプルだけ。匿名登録・個人データAPI・生成受付は無効 |
| `live-demo` | `staging`または`production` | `live` | `live` | 初期`false`、承認後`true` | 本物Auth・日記CRUDと期限削除service。実AI生成は停止し、画像のprivate保存・署名URLは未接続 |

- この表の組み合わせだけを許可し、不正な列挙値・未設定のモード変数は初回リクエスト時に拒否します。未設定の`GENERATION_ENABLED`は`false`として扱い、`true`/`false`以外の文字列は拒否します。
- `DATA_MODE=mock`の認証はVite開発ビルドかつlocalhost/127.0.0.1/::1でだけ許可します。本番ビルドでは開発用の許可を除去し、hostnameやAPP_ENVを偽装してもモック認証を拒否します。liveモードではSupabase SDKの`auth.getClaims(jwt)`で署名・期限を検証し、issuer・audience・UUID形式の`sub`を確認した後、`auth.getUser(jwt)`でAuthの現在のユーザーを確認します。読み取りは利用者JWT + RLS、書き込みはサーバー専用RPCを使います。実際のDB接続は別途stagingで検証してください。
- 実AIは`live-demo`で環境変数とDBの`enabled`が両方有効、かつ予算・認証・Queue等の公開条件を満たす場合だけ呼びます。他モードでの`GENERATION_ENABLED=true`は拒否します。
- local-connectedのmock予約は`reserve_mock_generation`だけで行い、DB policyが有効かつmock profileのときに限ります。実profileはこの経路から予約できません。
- Queueには`{ generationId }`だけを送ります。Worker Consumerはmock profileだけを実行し、重複配信はclaim RPCで抑止します。1分ごとの照合は未配送queuedを再送し、15分を過ぎたrunningはRPC結果に従ってfailed / unknown / heldを確定します。unknownを自動再実行しません。
- モードと公開可否はサーバー設定で固定し、ブラウザから変更させません。`.dev.vars.example`は`local-mock`、`dev.vars.local-connected.example`はSupabase接続を設定する開発用見本です。共有DBへのmigration適用前にlocal-connectedを有効なDBへ接続しないでください。

### PWA（Progressive Web App）の設計方針

- 基本構成：`manifest.webmanifest`、192px / 512pxアイコン、HTTPS配信、`standalone`表示、新バージョンの更新通知を用意します。
- キャッシュしてよいもの：バージョン付きの静的ファイル（JS / CSS / アイコン）と、公開用の架空サンプルのみ。
- 永続キャッシュしてはいけないもの：
  - APIレスポンス、認証情報（JWT）、日記本文、署名付き画像URL、個人の生成画像はService Worker等に永続キャッシュしません。
  - 全GETリクエストの一括キャッシュや、オフライン中の生成予約キューイングは実装しません。
- 更新時の配慮：ユーザーが日記を入力中・生成操作中のタイミングでは画面を自動リロードさせず、古い画面キャッシュと新しいAPIの組み合わせでも壊れないことを検証します。

---

## 4. 決定事項と未決定事項の整理

### 会議・ユーザー希望で確認済みの事項

- 「日記入力 → 4コマ生成 → 保存 / 振り返り」のコア体験
- スマートフォン中心のPWA対応
- `main`ブランチ＋PRレビュー＋Merge commitによるチーム開発
- 低コスト運用・クラウド保存・ログイン不要の匿名デモ・生成回数/予算の制限

### 技術的な追加設計判断（本ドキュメントで定義）

- 上記の技術スタック（React + Vite + Hono on Cloudflare Workers + Supabase）の採用
- すべてのデータ書き込みをHono API経由（サーバー専用RPC）に限定
- DB RPCによる生成枠の原子的（1トランザクション）予約
- 公開環境での非同期生成へのCloudflare Queues採用
- 生成画像の非公開（private Storage + 短命署名URL）管理
- 実AIの初期状態を「停止（disabled）」とし、データ保持期間を30日間に制限
- 静的アセットのみに限定したPWAキャッシュ

#### 技術選定の理由と再評価の条件

- Vite + 単一Worker構成：非公開SPAとAPIをシンプルに一体配信できるため採用しました。
- Supabase：匿名認証からDBの行単位権限（RLS）・所有者分離までを少ない実装量で揃えられるため採用しました。
- Queuesと専用RPC：重複配送への対応や権限管理の実装コストはかかりますが、「通信切断による失敗」「AIの二重課金」「同時アクセスによる予算上限突破」を防ぐために採用しています。
- ※ 将来もし「SNSのような一般公開/SSRが主機能になる」「画像ストレージ容量が支配的になる」「ハッカソン後に長期運用する」といった変化があれば、構成を再評価します。

### 未決定事項と決まるまでの扱い

| 未決定の項目 | 決まるまでの扱い（仮方針） |
|---|---|
| AIモデル・画像解像度・1枚/4枚方式 | 品質と費用を比較実験し、画面とAPIは両方の形式（`page` / `panels`）のモックで先行開発する |
| 費用負担者・総予算・無料枠/特典の扱い | 費用負担者の承認が出るまで未確認分は予算`0`とし、実AIの生成は停止しておく |
| 公開URL・Supabase Project ref・依存ライブラリの正確な版 | 初期基盤の構築・環境設定時に動作確認して固定する |
| P1機能の採否・長期保存・正式ログイン・ライセンス | チームで合意するまでは、30日保持のデモ仕様以上の約束をしない |

※ 設計判断を変更する場合は、「変更日・理由・トレードオフ（代償）・既存コードへの移行影響」をこのファイルへ追記し、担当者と合意します。

---

## 根拠資料と技術リファレンス

- 企画・要件の根拠：10/26・10/27チーム会議の文字起こし、および「漫画日記」機能メモ（要約よりも原本の記録を優先します。個人の発言を含む原本ファイル自体はGitには含めません）。
- 公式技術ドキュメント（※既存資料の確認日は2026-10-27。実装時に採用バージョンと公式仕様を改めて照合します）：
  - [Cloudflare Workers × Honoガイド](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
  - [Cloudflare Queuesの配送保証（Delivery Guarantees）](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
  - [Cloudflare Workersのプラットフォーム制限](https://developers.cloudflare.com/workers/platform/limits/)
  - [Vite PWAプラグイン公式ガイド](https://vite-pwa-org.netlify.app/guide/)
