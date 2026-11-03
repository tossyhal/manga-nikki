# 安全対策と公開条件（OPERATIONS）

> local-connectedの生成受付・quota / status API・Queue経由の固定mock処理と未配送/期限照合を追加しました。期限切れ日記の物理削除RPCとserver専用cleanup serviceもありますが、Scheduled handlerへの接続は未実装です。共有DBへの適用・実Supabase / Queue / Turnstile結合確認、実AI・Storage画像保存は未実施です。隔離PostgreSQLテストは架空profileと仮想予算だけを使い、実AIは呼びません。通常の開発はモック（`mock`）で行い、実AIの接続・課金発生・有料化・本番公開は必ずチームでの別承認を必要とします。

---

## 1. 認証とアクセス権限（RLS / RPC / Storage）

用語の意味は[READMEの用語集](../README.md#glossary)を参照してください。本アプリではHono APIだけでなく、DBやStorageへの直接アクセスも制限します。

### 認証・DB・Storageの境界ルール

- JWTと匿名認証の検証
  - 認証セッションの保存・更新はSupabase SDKに管理させます。現行設計はHttpOnly Cookie方式ではありません。JWTをURLのクエリやフラグメントへ入れません。
  - Workerは`Authorization: Bearer <JWT>`を厳密に読み取り、Supabase SDKの`auth.getClaims(jwt)`で署名・期限を検証します。その後、`iss`が`${SUPABASE_URL}/auth/v1`、`aud`が`authenticated`、`sub`が有効なUUIDであることを個別に検証し、`auth.getUser(jwt)`でAuthサーバーから得た現在のユーザーIDとの一致も確認します。
  - Auth/JWKSの依存先障害や接続設定不備は503として扱い、不正JWTは401として扱います。JWT・認証ヘッダー・生のSDKエラーはレスポンスやログに含めません。
  - `getClaims`はJWTの署名と期限を確認し、`getUser(jwt)`はAuthサーバーへ現在のユーザーを照会します。Supabaseは`getUser`をサーバー側でセッション終了を検出する手段として案内しています。一方、sign-outで失効したaccess tokenも`exp`までは有効とされるため、この照会だけで全API操作の即時失効を保証するとは説明しません。セッションIDをDB照会する追加制御は未実装です。
  - Supabaseの匿名AuthユーザーもDB上は`authenticated`ロールになるため、「ログイン済みロールであること」だけでデータを公開せず、必ず`owner_id = sub`（所有者一致）を確認します。
<a id="認証とセッション失効の確認範囲"></a>

#### 認証とセッション失効の確認範囲

- 各保護APIは`getClaims(jwt)`で署名・期限・issuer・audience・subjectを確認し、その後`getUser(jwt)`でAuthサーバーから現在のユーザーを取得してsubjectと一致することを確認します。明確な認証拒否は401、依存先障害は503です。
- `getUser`はリクエストごとにAuthサーバーへ接続するため、Authサービス障害時には個人APIを利用できません。Supabaseはこれをサーバー側でセッション終了を検出する方法として案内していますが、失効済みJWTは有効期限`exp`まで残りうるとも明記しています。したがって即時失効は保証せず、`session_id`を使った`auth.sessions`照会も現行APIでは行いません。
- 公式資料：[Authサーバー側ガイド](https://supabase.com/docs/guides/auth/server-side/advanced-guide)、[Auth sessions](https://supabase.com/docs/guides/auth/sessions)、[Signing out](https://supabase.com/docs/guides/auth/signout)。
- 読み取りと書き込みの分離
  - 読み取り（SELECT）には利用者JWTを付けたリクエスト単位のクライアントを使い、RLSで自分のデータだけを取得します。実装では`createUserSupabaseClient`と、secret keyだけを使う`createServerRpcClient`を別factoryにし、incoming Authorization headerをRPC clientへ渡しません。
  - 書き込み（INSERT / UPDATE / DELETE）はCloudflare Worker内のサーバー専用RPCからのみ行います。API側とRPC内の両方で所有者を二重確認し、Supabase secret keyを使うクライアントはサーバー内部だけに閉じます。
  - 日記CRUDとgeneration / quota / status APIは実装済みです。読み取りには利用者JWTとRLS・API側owner条件を使い、書き込み・mock予約・状態確定はsecret専用RPC経由です。local-connectedでは生成専用Turnstile、mock profile限定予約、Queue、固定fixtureのstatus遷移、未配送再送・期限照合を使います。real profileの受付とlive-demoの新しい実AI生成、private Storage保存は未接続です。
- テーブル権限（Grants）とRLS
  - `public`スキーマの業務テーブルには、RLSとテーブル権限（grants）の両方を設定します。
  - `anon`ロールのアクセス、および`authenticated`ロールによる直接の`INSERT` / `UPDATE` / `DELETE`を禁止し、「自分のデータかつ未削除かつ有効期限内」の行だけを`SELECT`可能にします。
- 非公開スキーマと専用RPCの保護
  - 利用枠・予算・試行履歴（`quota` / `policy` / `attempts`）は`private`スキーマに置き、外部へ非公開とします。
  - サーバー専用RPCの実行権限（`EXECUTE`）は、`PUBLIC`・`anon`・`authenticated`から明示的に剥奪（REVOKE）します。
  - 関数は原則`SECURITY INVOKER`とし、どうしても`SECURITY DEFINER`が必要な場合は「空の`search_path`指定・スキーマ完全修飾名・関数内部での所有者検証」を必須とします。
  - `service_role`は`generation_policy`をSELECTだけに限定し、`quota_counters`は予約のためSELECT / INSERT / UPDATE、`reservations`はSELECT / INSERTと`state`列UPDATE、`provider_attempts`はSELECT / INSERTと`state`・`request_id`・`finished_at`列UPDATEを許可します。どちらのledgerにもDELETE権限はありません。`SECURITY INVOKER`の必要権限としてDBロールへ付与するもので、アプリ通常経路はサーバー専用RPC client factoryに限定します。`anon`・`authenticated`にはprivate schema usageを付与しません。
- Storage（画像）の非公開管理
  - ブラウザからStorageへの直接`SELECT`・署名URL発行・直接アップロードはすべて禁止します。
  - Hono APIが「`asset` → `job` → `entry`の所有者一致・未削除・有効期限内」を照合した上で、有効期限60秒の署名URLを発行します。
  - 発行された署名URLをDB・`localStorage`・Service Worker等へ保存してはいけません。また、ファイルパスの先頭文字列（プレフィックス）だけで認可判定を行いません。
- CAPTCHA（Cloudflare Turnstile）と会場ネットワーク対策
  - 匿名サインアップ時と漫画生成リクエスト時では別々のTurnstileトークンを使用し、生成側では`hostname`や`action`も検証します。
  - APIはCAPTCHA検証前にサーバー専用`find_generation_receipt` RPCで既存要求を照会します。receiptがあれば`202`で返し、`null`なら生成専用Turnstile Siteverifyで`action=generate`と許可hostnameを確認してから`reserve_mock_generation`を呼びます。wrapperはpolicy lock下でmock profileを確認し、既存予約RPCも並行要求に備えて同じreceiptを再確認します。
  - 同じ`Idempotency-Key`による通信再送では新たなCAPTCHAや生成枠を消費しませんが、JWT認証・有効な本人entry・リクエストハッシュは必ず再確認します。
  - ハッカソン会場など同一IPアドレスから多数のアクセスがあり匿名登録が制限される場合は、架空サンプルの閲覧へ誘導します。

---

## 2. 秘密情報と個人データの保護

### 公開設定と秘密情報の分離

- `.env.local`（`VITE_*`）はブラウザに公開される値だけを入れます（Supabase URL / publishable key、Turnstile site keyのみ）。
- Workerは`.dev.vars`またはWorker設定から`SUPABASE_URL`・`SUPABASE_PUBLISHABLE_KEY`を読み取り、Auth/JWKS検証と利用者JWT付き読み取りクライアントに使います。`SUPABASE_SECRET_KEY`はサーバー専用RPC client factoryだけに渡します。
- `pnpm build:staging` / `pnpm build:production`は対象環境のWorker設定を適用し、`dist/`を生成・検査します。ビルドはCloudflareへ接続・公開しません。Viteの環境ファイル読み込みを無効化し、対象環境の`.env.<環境>.local`にある許可済み3つの`VITE_*`だけを使います。`.env.local`・`.env.development.local`・`.dev.vars`・プロセス環境の`VITE_*`は使わず、Worker preview用にpluginが出力する`.dev.vars`も成果物から除きます。
- Workerの環境変数はstagingが`APP_ENV=staging`、productionが`APP_ENV=production`で、両方とも`DATA_MODE=sample`・`AI_MODE=mock`・`GENERATION_ENABLED=false`です。実AI・Queue・Storage・Supabase設定は追加していません。
- release buildでは`VITE_SUPABASE_URL`・`VITE_SUPABASE_PUBLISHABLE_KEY`・`VITE_TURNSTILE_SITE_KEY`だけをブラウザへ公開します。Supabase secret key、Turnstile検証用secret、AI APIキーを含む秘密情報はサーバー専用設定で管理します。
- `.dev.vars`およびCloudflare Workers Secretsに、秘密情報（Supabase secret key、Turnstileの検証用秘密情報、AI APIキー）を配置します。
- local-connectedの例は`dev.vars.local-connected.example`です。値を設定して`.dev.vars.local-connected`へコピーし、`CLOUDFLARE_ENV=local-connected pnpm dev`で開発環境を選びます。`TURNSTILE_SECRET_KEY`と`TURNSTILE_ALLOWED_HOSTNAMES`がない場合、生成受付は停止します。例に含まれるSupabase URLはplaceholderで、実接続情報や秘密値はGitへ入れません。
- Supabase secret keyまたは旧service_roleキーはRLSをすべて迂回できる特権を持つため、**ブラウザ側やGitリポジトリへ渡してはいけません。**万が一漏洩した場合は、直ちにキーを失効（revoke）・再発行します。

### プロンプトインジェクション・XSS・SSRF対策

- 外部AIへ送信するデータの最小化：日記本文と必要な固定設定だけを送信します。
- コード実行の禁止：日記本文に含まれる命令文・URL・HTMLタグを決して実行せず、AIの出力結果もすべて通常のプレーンテキストとして画面表示します（`eval`や`dangerouslySetInnerHTML`は使用禁止とし、CSPの許可先も最小限に絞ります）。
- 外部画像取得時の制限：AIプロバイダが画像URLを返す構成にする場合、取得先は「HTTPSのみ・許可されたホスト名のみ・リダイレクト時の再検証・ファイルサイズ上限あり」に制限し、任意のURLを取得する汎用ダウンローダーにならないようにします。

### ログ出力の禁止事項

- ログに残してよいもの：`requestId`、`generationId`、`stage` / `status`、処理時間、一般化した`errorCode`、画像バイト数、`modelId`、トークン等の`usage`のみ。
- ログに出してはいけないもの：
  - 日記の本文・AIへのプロンプト
  - JWT・Cookie・`Authorization`ヘッダー・各種APIキー
  - 画像のBase64データ・署名付きURL
  - AIプロバイダから返った生のエラーレスポンス
- 開発・CI・デモ動画の撮影には必ず架空の日記を使用し、アクセス元の生IPアドレスの恒久保存や行動追跡用のAnalyticsは導入しません。

---

## 3. 生成回数と予算の制限（コスト防衛）

### ポリシー管理とキルスイッチ（緊急停止）

- 制限設定の正本はDBの`private.generation_policy`テーブルです。
  - 初期値：`enabled = false`、全体の日次枠・全期間枠・金額予算はすべて`0`、ユーザーごとの上限は「1日2試行まで・同時実行1ジョブまで」（日付の切り替わりはサーバー側の日本時間JST基準）。
- 環境変数の`GENERATION_ENABLED="true"`と、DBの`enabled = true`の両方が揃っている場合のみ実AIの生成を動かし、状態の取得に失敗したり不明な場合は安全側に倒して停止します。
- `reserve_generation`はサーバー専用RPCの`p_generation_enabled`に環境変数の値を渡します。ブラウザからこの値や予算/profileを受けません。環境変数またはDB policyがfalseなら新規予約を拒否し、`find_generation_receipt`と`reserve_generation`の既存同一要求照会は停止中も同じjobを返します。
- `model_profile_json`はDB policyの正本です。空オブジェクトは未設定として停止します。設定profileには`profile_id`、`is_mock`、整数の`max_cost_micro_usd`を含め、最大費用を予約します。`is_mock=false`では最大費用0を許可しません。provider/modelなどの追加設定は日記本文やHTTP bodyから受けず、profile snapshotへ保持します。
- `reserve_generation`の予約ロック順は`generation_policy`→global total→global day→user day→entry/jobです。全予約がglobal total counterをロックするため、最後の全期間枠と総予算を超える並行受付は起きません。
- policy設定を変える運用者は、単独の短いtransactionで更新してcommitします。更新triggerと予約RPCは同じ2整数advisory transaction lockを使い、変更中のpolicy snapshotで予約が進まないよう直列化します。
- 匿名認証のユーザーIDは「ブラウザ単位」であり「人間1人」を保証しないため、ユーザー単位の上限だけでなくシステム全体の上限（全体枠・総予算）が必須です。

### 最大費用の見積もりと予約方式

- 1回あたりの最大費用 $C_{\max}$ の計算式：
  $$C_{\max} = (\text{脚本生成の最大入出力費用}) + (\text{画像1回の最大費用} \times \text{許可呼出回数}) + (\text{許可した追加呼出し分})$$
- 承認予算 $B$ に対する生成可能回数の上限：
  $$\text{生成数候補} = \lfloor B / C_{\max} \rfloor$$
- 金額はすべて整数（`micro USD` = $10^{-6}$ USD単位）で予約計算し、モデルの単価や出力トークン上限が不明な状態では外部公開しません（税金・為替変動・別用途のクラウド請求は別途余裕を見ます）。
- 現行DB RPCはscriptを1回、imagesをprofileの`max_image_calls`回まで（整数1〜4、未指定時1）に制限します。`max_cost_micro_usd`にはこの最大呼出し数を含めます。失敗後の自動再送はせず、同じstageの次imageは直前の成功後だけ開始できます。

| 予約状態（`state`） | 生成枠・予算金額の扱い |
|---|---|
| `reserved` | 生成受付済み。予約した最大金額分を全体予算・回数上限からあらかじめ差し引く |
| `consumed` | 外部AI呼び出しの結果が確定。予約していた最大金額分を消費済みとして確定する |
| `held` | [用語集](../README.md#glossary)の予約保持状態。自動では返却しない |
| `released` | 外部AIへ未送信であることが確認できた場合のみ取り消し。元の予約日のカウンターへ1回だけ枠を戻す |

- 予算運用の厳守ルール：
  - 生成成功時に「事前見積もり（$C_{\max}$）と実際の消費額の差額」が出ても、MVPでは自動的に余り枠として再利用しません。
  - ユーザーが後から日記を削除したり日付を変更しても、過去に消費した回数や支出カウンターは減らしません。
  - AI SDKの自動リトライ機能は無効にします。リクエスト送信後のタイムアウトや中断を「無料の失敗」とみなして自動再送してはいけません。再試行機能を別途承認する場合は、呼出し上限と$C_{\max}$を同時に見直します。
  - Queueのメッセージ再試行（retry）によって同じAI呼び出しを再実行せず、`unknown` / `held`状態にして人間が調査します。

### 実AI有効化前の承認記録ルール

実際に課金されるAI生成を有効化する前に、「費用負担者・承認金額・利用プロバイダ/プロジェクト・モデルプロファイルと $C_{\max}$・日次/全期間枠・承認日」をこのドキュメントへ記録します。

> 【現在の承認状態】
> 費用負担者・採用モデルともに未決定、承認予算額は`0`、実AIでの生成は不可（停止中）です。
> ※ 無料枠やクレジット特典を使う場合も、「請求先・対象API・残高・有効期限」が明確に確認できるまでは予算`0`として扱い、無料枠切れの際に別の有料モデルへ自動フォールバックさせません。

---

## 4. 環境分離と公開までの手順

1. 環境の分離（local / staging / demo）
   - 変数の組み合わせは[動作モード対応表](ARCHITECTURE.md#mode-matrix)に従います。localはモック、stagingは架空データ、demoは別のSupabaseプロジェクト・APIキー・Queueを基本とします。
   - もしSupabaseの無料プロジェクト作成枠が足りない場合は、通常開発をローカルDBまたはモックで行い、ハッカソン参加者のデータが入る環境でDB resetを混在させないようにします。
2. Supabase側の設定
   - 匿名AuthとTurnstile連携、レビュー済みのSQL migration、private Storageバケット（`comics`）、RLS / RPCの権限を設定します。
   - migrationファイルは`supabase/migrations/`で再現可能にし、共有DBへ適用する際はレビュー後に接続先と適用順序を確認してから実行します。
3. Cloudflare Workers側の設定
   - local-connectedのQueue consumer / Cronは`wrangler.jsonc`に定義済みです。Queue bindingは`GENERATION_QUEUE`、queue名は`manga-nikki-generations-local-connected`、consumer batch size 1 / concurrency 2、未配送照合Cronは1分です。Wranglerの環境設定は各envへbindingが継承されないため、live-demo用のQueueは本作業で作成・有効化していません。remote Queue作成やdeployも行っていません。
   - クラウド上で誤ってモック認証が起動できないことを必ず確認します。
4. 段階的な検証とデプロイ
   - 「標準検査（lint / typecheck / test / build） → `pnpm build:staging`による成果物確認 → staging環境での統合検証 → demo環境のDB / Queue / 秘密情報確認 → 別承認後の少数の実生成による計測」の順に進めます。
   - `build:staging` / `build:production`と`pnpm preview`はローカルの成果物作成・確認であり、実環境へ公開しません。実デプロイは接続先・binding・秘密情報・公開条件を確認した後、別途明示承認を得てから対象環境のbuild成果物に対して`pnpm exec wrangler deploy`を実行します。Cloudflare Vite pluginはbuild時に環境を選択し、生成済みの環境別Wrangler設定を使うため、deploy時の`--env`指定はしません。現在デプロイ用scriptはありません。この作業では実デプロイを行っていません。
   - ストレージ容量・転送量・WorkerのCPU/メモリ・Queueの利用枠を実アカウントで確認します。
   - Supabaseの休止条件と匿名登録レート制限を確認します。
   - 画像サイズ上限は目標サイズではありません。平均サイズ×生成件数で容量、さらに閲覧回数を掛けて転送量を見積もります。
   - 古い料金表の数値を予算の根拠にしません。

---

## 5. 公開前チェックリスト

- 通常CIは実際の秘密情報を使わず、モック環境でlint・型検査・unit・build・E2Eを実行します。
- local-connectedのDB / Queue結合は隔離環境と固定mockだけで行います。実AI確認は別承認後、承認された少数の架空日記だけで行います。
- **PRのCIへ本番の秘密情報を渡しません。**`pull_request_target`で未信頼コードを実行せず、Actionsの版と権限を固定・最小化します。

| 確認するテスト状況・シナリオ | 合格条件（すべて満たすこと） |
|---|---|
| 空白のみ・文字数超過・不正な日付/未来日・未知のJSONキー・不正な4コマ形式 | すべてバリデーションで拒否され、保存や生成処理へ進まない |
| 「入力 → 漫画生成 → 履歴一覧 → 詳細への再訪」、`page` / `panels`両形式 | 同じ記録と脚本テキストが正しく表示され、日記にない事実を捏造しない |
| JWTなし / 偽造 / 別プロジェクト / 期限切れ、他人の`entry` / `job` / `asset`指定 | 認証エラーで拒否、他人のリソースは一律`404`となり署名URLも発行されない |
| `anon`・ユーザーA・ユーザーBによる直接のREST / RPC / Storageアクセス | 他人データの閲覧、直接の書き込み、専用RPCの直接実行、Storage署名発行がすべて拒否される |
| 同一`Idempotency-Key`の同時リクエスト / 異なる内容、最後の1枠への同時リクエスト | 生成ジョブと枠予約は1件だけ作られ、別内容は`409`、予算・回数上限の超過が起きない |
| 匿名ユーザーIDの再作成、全体/期間/金額上限への到達、キルスイッチ停止時 | ユーザーを作り直しても全体上限で止まり、停止時は未開始のAIプロバイダを一切呼ばない |
| サインアップ用と生成用のTurnstileトークン使い回し、会場等の同一IPからの多人数利用 | トークン使い回しは拒否され、IP制限時は意図通り架空サンプル画面へ案内される |
| Queueの重複配信、DB予約後のQueue送信失敗、外部AI送信後の通信中断 | mock重複配信はclaimで1回だけ処理し、未配送は照合で再送する。実AI経路は未接続で、将来は結果不明を`unknown` / `held`として安全に止める |
| Storage保存成功後のDB失敗、古いジョブの遅延完了、生成中の日記削除 | AIの再生成が起きず、新しい`latest_generation_id`が巻き戻らず、削除済みデータが復活しない |
| JST日付境界（0時またぎ）、30日保存期限切れ / 削除処理中のStorage障害 | 元の予約日のカウンターだけで精算され、画面からは即座に非表示となり削除が裏で再試行される |
| 通信切断・ページ再訪・PWA更新・キャッシュ・HTMLや命令文の入力 | 新規ジョブの勝手な作成、入力中の本文消失、個人データのキャッシュ残留、スクリプト実行が起きない |
| スマートフォン実機・実際の生成画像・サーバーログの確認 | WorkerのCPU / メモリ / 容量が制限内に収まり、ログに日記本文や秘密情報が一切混入していない |

- 検証時の注意：
  - RLSのテストは特権（Supabase secret key / service_role）だけで行わず、必ず実際の匿名ユーザー権限で検証します。
  - 同時アクセスの競合テストでは、HTTPレスポンスの成功数だけでなく、DB内の「ジョブ数・予約レコード数・カウンター値・AIプロバイダ呼び出し回数」まで一致しているか確認します。
  - もし「認証・権限・予算制限・重複防止・障害時挙動・削除・緊急停止」のいずれか1つでも未確認であれば、実APIは外部公開せず、架空サンプルと事前録画で発表します。

---

## 6. 障害時の対応とハッカソン終了後の片付け

### 障害発生時の対応（インシデント対応）

- 異常な課金やAIプロバイダ障害：ただちにDBの`private.generation_policy.enabled = false`に変更して生成を止め、必要に応じてAPIキー自体を失効させます。
- 削除・保存期限・claim期限を越えて送信済みprovider応答が戻った場合も、attemptの確定stateとrequest IDを記録してから精算します。結果記録でjobや日記を再表示させず、既知費用の枠は返却しません。
- `unknown`ジョブの発生：プロバイダの`requestId`を使って管理画面やログで実行有無を調査し、自動での再呼び出しは行いません。
- Supabase Authの障害：代替として「全員共通のログインアカウント」を配るような危険な回避策はとらず、架空サンプルの閲覧へ誘導します。
- デプロイ不具合：問題のあるWorkerは直前の正常なバージョンへロールバックし、DBの不整合は自動逆マイグレーションや破壊的な`reset`ではなく、互換性を確認した修正用migrationで直します。

### データ削除とハッカソン終了後の処理

- 本人の削除操作または作成から30日で、閲覧と新しい署名URLの発行を止めます。
- Storageの物理画像→DBメタデータの順に削除します。障害やプロジェクト休止で失敗した場合は復旧後に再試行します。
- 発行済み署名URLの最大60秒の残存、外部AIの保持、DBバックアップは別の制約として事前に説明します。
- 未参照画像・古い匿名ユーザー・残存ジョブも確認して掃除します。
- 大会後は実AIを停止するか、継続予算・正式認証・保存期間を改めて合意します。
- コード・migration・架空サンプル・発表動画は保管し、実ユーザーの日記をGitや宣伝素材へ転用しません。

---

## 公式ドキュメント・料金表リファレンス

※ 旧資料での確認日は2026-10-27です。実装および公開作業の前に最新の公式仕様を再確認してください。

- セキュリティ・機能仕様
  - [Supabase匿名サインイン（Anonymous Sign-Ins）](https://supabase.com/docs/guides/auth/auth-anonymous)
  - [Supabase JWT検証](https://supabase.com/docs/guides/auth/jwts)
  - [Supabase Auth getUser/getClaims](https://supabase.com/docs/guides/auth/server-side/advanced-guide)
  - [Supabase Auth sessions](https://supabase.com/docs/guides/auth/sessions)
  - [Supabase Auth sign out](https://supabase.com/docs/guides/auth/signout)
  - [PostgreSQL Row Level Security (RLS)](https://supabase.com/docs/guides/database/postgres/row-level-security)
  - [Supabase Database Functions (RPC)](https://supabase.com/docs/guides/database/functions)
  - [Supabase Storageアクセス制御](https://supabase.com/docs/guides/storage/security/access-control)
  - [Supabase APIキーの扱い](https://supabase.com/docs/guides/getting-started/api-keys)
  - [Cloudflare Turnstileサーバーサイド検証](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
  - [Cloudflare Workers Secrets管理](https://developers.cloudflare.com/workers/configuration/secrets/)
  - [Cloudflare Workers Vite pluginの環境選択](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)
  - [Cloudflare Workers Vite pluginのbuild成果物とdeploy](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/)
- 利用枠・料金プラン
  - [Supabase Pricing](https://supabase.com/pricing)
  - [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  - [Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
  - [Cloudflare Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
