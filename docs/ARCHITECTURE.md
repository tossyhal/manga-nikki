# 構成と設計判断（ARCHITECTURE）

> 2026-10-27に採用した実装方針です。全体の構成・共通型・公開条件を先に揃え、通常の開発はモックで進めます。

PR#29までの変更は`main`へ統合済みです。現在のbranchではlive-demo用のOpenAI白黒profile、原子的予約、attempt ledger、Queue runner、private Storage保存・assets登録・成功確定RPC・復旧runtimeをdefault Workerへ接続しています。共有DBへのmigration適用と実AI/クラウド環境の検証は未実施です。詳細は[PLAN](PLAN.md)を参照してください。

---

## 1. システム構成と各層の役割

```text
React PWA ─ Supabase Auth（匿名サインイン・トークン更新）
    └─ Hono API / Cloudflare Workers（JWT検証・所有者確認）
         ├─ PostgreSQL（読み取りは利用者JWT + RLS、書き込みはサーバー専用RPC）
         ├─ private Storage（画像保存・短命の署名URL発行）
         └─ Queues（job IDのみ送信）→ 同じWorkerのConsumer → AI生成 → 保存
Scheduled handler（定期実行）→ 未配送jobの再送・停止状態の照合・期限切れ保存taskの復旧・保存期限/削除処理
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

- 運用資格情報の保管にはBitwarden Secrets Managerを使います。staging Environmentの`BWS_ACCESS_TOKEN`はdev project全体をread-onlyで読めるmachine accountのtokenで、既存の開発用Supabase secret等にも権限があります。workflowは`BWS_CLOUDFLARE_SECRET_ID`で指定したstaging Worker専用Cloudflare token 1件だけをActionへ要求し、production secretはdev projectに保存しません。初期作成用tokenと旧Secret IDは退役済みです。詳細は[デプロイ基盤](DEPLOYMENT.md)に記載します。
- チームの開発ブランチへのpushとPR作成は維持し、mainのmerge・production操作は所有者に限定します。staging sample CDはRepository variableで明示有効化した後、保護された`develop`へのpushからCI成功後にだけ動きます。既存Worker以外を作成せず、架空sampleだけを公開します。
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
4. AI呼び出しと保存（Consumer → OpenAI → 保存handler）
   - OpenAI白黒profileはscriptを1回、画像を最大4回呼びます。各SDK呼出し自体の前にDBでattemptを開始し、response後にrequest IDと既知状態を記録します。
   - scriptと4枚の画像を検証した後、`mark_generation_saving`を呼び、保存handlerへgeneration/owner/claim、script、画像bytes、provider metadataを渡します。
   - `createGenerationSaveRuntime`はscript/manifestをDB taskに保存し、画像4枚をprivate Storageへ保存後、completion RPCでgenerationを`succeeded`にします。各画像のsignature・MIME・寸法・size・SHA-256を検証し、120秒の独立save leaseとAbortSignalを守ります。両handlerはdefault `createWorker`へ注入済みです。新規live生成はQueue・Turnstile・API key・環境flag・DB policyも含むready条件が揃わない限り開始しません。
5. 中断・障害時の扱い
   - 外部AIへリクエストを送信した後に処理が中断した場合は、[用語集](../README.md#glossary)の`unknown`として記録・照合します（`running`状態のジョブを自動的に`queued`へ戻して再実行することはしません）。
   - 保存handlerの一時障害はQueue messageをackし、jobを`running` / `saving`のまま保ちます。復旧handlerはsave taskから既存objectを照合し、DB完了を再開します。欠損・不正objectはAIを再実行せず`failed` / `consumed`にします。DBは通常精算、復旧、enqueue候補の順に選び、復旧は最大3件、enqueue候補がある場合は残枠のおよそ半分までに制限します。retry futureのsaving jobは候補から外し、24時間を超えたjobは通常expireへ回します。
   - Runtimeの実行順は通常精算→enqueue→保存復旧です。Queue送信枠を先に確保し、復旧callbackの前に`begin_generation_save_recovery`でDB markerを取得します。1回のCronでは最大3 callback、各最大120秒、原claim deadlineから24時間以内に実行します。RPCがmarkerを5分先へ進めるため、保存復旧の各試行には5分のbackoffがあります。
   - 保存taskはscript、comic draft、順序付きplanned manifest（asset ID/path、MIME、寸法、size、SHA-256）だけを保持し、画像bytesはStorageに置きます。復旧callbackはtaskとgeneration IDから保存だけを再開し、新しいAI呼出しをしません。必要なobjectが復旧できない場合は安全な失敗・取消を確定します。
   - live-demo Cronの保存復旧は`recoverGeneratedComic`があれば`GENERATION_ENABLED=false`やOpenAI API key不在でも動作します。新規AI呼出しのready条件とは分離します。`save_recovery_retry_at`の5分backoffが抑制するのは復旧callbackの再試行だけで、取消・削除・entry期限切れ・元claim deadlineから24時間超の通常精算は待機中も行われます。このmarkerは保存専用leaseではありません。保存担当が実装する完了RPCはlock下で`status=running`、owner、期限（元claim deadlineから24時間以内の復旧期限を含む）、削除/cancel、保存専用leaseを再検証し、終端化済み・削除済みgenerationを`succeeded`へ戻してはいけません。復旧期限を過ぎたjobは通常expireでfailed / consumedとして精算し、予約をreleaseせずAI再実行もしません。

### キューとタイムアウトの初期設定値

- Queue設定：1本、初期値は`batch size: 1`・`concurrency: 2`。
- 時間制限の目安：AIプロバイダ呼び出しのtimeoutは120秒、ジョブ全体の完了目標は10分、進行が15分停止したものは`unknown`候補とします。
- 定期処理（Cron）：`* * * * *`は未配送jobの再送・期限照合、`0 15 * * *`（UTC）はJST 0時の期限削除です。Cron文字列でhandlerを分け、dailyは`local-connected` / `live-demo`に限り個人データへ接続します。1回に最大10entryを処理します。
- Provider単体のローカル確認用endpointは開発ビルドのlocalhostだけに限定し、liveのQueue処理と同じDB予算台帳は使いません。課金を伴う利用には別承認が必要です。

---

## 3. 動作モードとPWAキャッシュ方針

### サーバーの動作モード（4種類）

<a id="mode-matrix"></a>

設定検証、local-mock、preview-sample、liveモードのJWT検証と日記CRUD接続は実装済みです。local-connectedとlive-demoでは日記一覧・詳細・作成・編集・論理削除をSupabase DBへ接続します。local-connectedはgeneration受付・quota・status読取・Queue・未配送再送・期限照合を固定mockで実行します。live-demoには固定OpenAI profileの予約・Queue Consumer・attempt台帳・private画像保存・assets登録・保存復旧・実Storage署名URLを接続しています。`/assets/:id/url`は固定mockに公開サンプル画像を返し、実assetには所有者・有効なentry・成功済みgeneration・comic参照を照合して署名URLを返します。期限削除serviceを日次Scheduled handlerへ接続しました。`local-connected`と`live-demo`は実行対象、`sample`・malformed modeは個人DB/Storageへ接続しません。staging/productionはsample/offでQueueも未設定のため、実生成は受付されません。`demo` Wrangler targetはlive-demo用設定を準備していますが、Queue・Secrets・共有DB migration・deployは未実施です。`APP_ENV`は実行環境、`DATA_MODE`は保存・認証の方式、`AI_MODE`は生成adapterを選びます。`GENERATION_ENABLED`は新しい実AI呼出しの許可で、mock生成や既存saving taskの復旧には不要です。preview-sampleでは生成受付を無効にします。過去の一部ローカル結合確認と未確認項目は[README](../README.md)を参照してください。

| モード | APP_ENV | DATA_MODE | AI_MODE | GENERATION_ENABLED | 挙動 |
|---|---|---|---|---|---|
| `local-mock` | `development` | `mock` | `mock` | `false` | localhost限定の仮ユーザー・仮保存・固定漫画 |
| `local-connected` | `development`または`staging` | `live` | `mock` | `false` | 開発Supabase・本物Auth・Queue経由の固定mock漫画で結合確認。Queue/Turnstile secretsがなければ新規受付は停止 |
| `preview-sample` | `staging`または`production` | `sample` | `mock` | `false` | 架空サンプルだけ。匿名登録・個人データAPI・生成受付は無効 |
| `live-demo` | `staging`または`production` | `live` | `live` | 初期`false`、別承認後に設定 | 本物Auth・日記CRUD・実AI Queue経路。policy/予算/Turnstile/Queue/OpenAI key/保存・復旧handlerが揃わなければ新規生成を停止。専用`demo` targetは`APP_ENV=staging`で隔離設定を準備するが、resource/secret/DB/deployは未適用 |

- この表の組み合わせだけを許可し、不正な列挙値・未設定のモード変数は初回リクエスト時に拒否します。未設定の`GENERATION_ENABLED`は`false`として扱い、`true`/`false`以外の文字列は拒否します。
- `DATA_MODE=mock`の認証はVite開発ビルドかつlocalhost/127.0.0.1/::1でだけ許可します。本番ビルドでは開発用の許可を除去し、hostnameやAPP_ENVを偽装してもモック認証を拒否します。liveモードではSupabase SDKの`auth.getClaims(jwt)`で署名・期限を検証し、issuer・audience・UUID形式の`sub`を確認した後、`auth.getUser(jwt)`でAuthの現在のユーザーを確認します。読み取りは利用者JWT + RLS、書き込みはサーバー専用RPCを使います。実際のDB接続は別途stagingで検証してください。
- 実AIは`live-demo`で`GENERATION_ENABLED=true`とDBの`enabled`が両方有効、固定profile・予算・quota・認証・Turnstile・Queue・OpenAI key・保存handler・復旧callback等がすべて整う場合だけ呼びます。default Workerには保存・復旧handlerを注入済みですが、現在のstaging/productionはsample/off・Queue未設定のため無効です。他モードでの`GENERATION_ENABLED=true`は拒否します。
- local-connectedのmock予約は`reserve_mock_generation`だけで行い、DB policyが有効かつmock profileのときに限ります。実profileはこの経路から予約できません。
- Queueには`{ generationId }`だけを送ります。Worker Consumerはlocal-connectedのmock profileまたはlive-demoのOpenAI profileを実行し、重複配信はclaim RPCで抑止します。1分ごとの照合ではDBが取消・削除・期限切れjob、復旧可能なOpenAI saving job、未配送queued jobの順に候補を選びます。Runtimeは候補を通常精算→enqueue→保存復旧の順に実行し、queue送信のための枠を確保します。保存復旧はcallbackがあれば新規生成flagやOpenAI keyなしで動作し、最大3件/cron、各120秒、元claim deadlineから24時間以内に限り、AIを再実行しません。`unknown`を自動再実行しません。
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
| 初期OpenAI profileの継続採用・課金品質・実アカウント権限 | PR#41でgpt-4.1-mini-2025-04-14 + gpt-image-2.5-flareの白黒4枚方式を固定profileにした。費用負担・課金予算・品質・権限の承認までは実AIを停止し、長期運用前にdeprecated script modelの移行を再評価する |
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
