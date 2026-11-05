# 漫画日記 / manga-nikki

書いた日記を、読み返したくなる4コマに。

日記をAIで4コマ漫画に変換して保存・閲覧できる、スマートフォン向けPWAです。
技育CAMP2026ハッカソンVol.6にて、チーム「27卒」が開発します。

> 現在の状態（2026-11-06時点）
> PR#29までの変更は`main`へ統合済みです。現在の作業branchでは、OpenAI白黒生成のQueue経路に加え、画像のprivate Storage保存・DB完了確定・保存復旧・署名URL取得までをdefault Workerへ接続しています。段階ごとの詳細は[PLAN](docs/PLAN.md)を参照してください。
>
> 匿名Auth・日記CRUD/編集・RLS/RPC、原子的な生成枠予約とclaim / attempt / lease / unknown、固定mock Queue経路、CAPTCHA・利用枠UI、PWA、期限削除、環境別sample buildと公開設定guardを実装しています。実生成画像はprivate `comics` bucketへ決定論的なpathで保存し、binary signature・MIME・寸法を照合します（8 MiB/画像、16 MiB/4コマ、2,048px/辺、4 MP/画像、16 MP/4コマ）。DB完了失敗後は保存済み画像を再検証して完了を再開し、欠損・不正画像は追加AI呼出しなしで失敗・消費確定します。本人の有効な日記、成功済みgeneration、comic内のasset参照を確認した後だけ60秒の署名URLを返し、署名直後にも状態を再確認します。閲覧中に署名URLが期限切れした場合は1回だけ自動再取得し、その後は手動操作で再試行します。local-mockでは日記→固定漫画→仮保存→再読込を確認できます。local-connectedでは固定mockの画像URLに公開の架空サンプルを返します。staging/productionは引き続き`sample` / `mock` / `GENERATION_ENABLED=false`でQueue bindingなしです。独立した`demo` Wrangler targetと隔離buildは準備しますが、Cloudflare resource作成・秘密情報登録・共有DBへのmigration適用・deployは行っていません。実AI課金・アカウント権限・品質、共有DBへのmigration適用、実Turnstile・実Cloudflare Queue / Cron、公開環境の全経路は未確認です。

> 以前、隔離Supabase CLI / PostgreSQL / Auth / PostgREST / StorageとローカルQueueで、匿名Auth A/B、日記作成・再取得・PATCH競合・他owner拒否、service fixtureからの固定mock Consumer、Storage→DB期限削除service、一部Storage RLSを確認しました。これは部分的な過去検証で、実Turnstile・共有DB・実Cloudflare Queue / Cron・HTTPSスマホ実機や、最新branchの全経路を確認したものではありません。この文書同期では再実行していません。

日記・生成・private画像保存用migration、RLS、専用RPCと隔離PostgreSQLテストがあります。共有DBへのmigration適用と実クラウド環境での結合確認は未実施です。隔離環境での部分検証の範囲は[supabase/README.md](supabase/README.md)を参照してください。

## 最初に読むドキュメント

開発を始める際は、まず以下の3つを順番に読んでください。

1. この`README.md`：プロジェクトの全体像とドキュメントの案内
2. [仕様（docs/SPEC.md）](docs/SPEC.md)：作るアプリの機能・画面・完成条件
3. [開発手順（CONTRIBUTING.md）](CONTRIBUTING.md)：環境構築・コマンド・GitとPRの進め方

### 開発の基本方針

- まずはモックで画面を一通りつなぐ
  最初は共通の初期基盤を作り、「日記入力 → モック漫画の表示 → 保存・再取得」までの流れを通します（初期基盤の範囲は[CONTRIBUTING.md](CONTRIBUTING.md)を参照）。
- デザイン・AIモデル・DBの完成を待たずに並行開発する
  共通の型定義とモックデータを使って先行して開発を進めます。
  - 全体の構成・技術選定：[ARCHITECTURE.md](docs/ARCHITECTURE.md)
  - 画面とサーバーをつなぐ型・API仕様：[API.md](docs/API.md)
  - 認証・費用制限・公開条件：[OPERATIONS.md](docs/OPERATIONS.md)

## ドキュメント一覧

| 文書 | 内容 | 読むタイミング |
|---|---|---|
| [SPEC](docs/SPEC.md) | MVPの範囲・画面構成・完成条件 | 全員・最初に読む |
| [CONTRIBUTING](CONTRIBUTING.md) | 環境構築・確認コマンド・Git/PRルール | 全員・開発開始時 |
| [PLAN](docs/PLAN.md) | 開発ステップ・完了の目安・スケジュール | 全員・タスク確認時 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | システム構成・技術選定・未決定事項 | 実装に入る前 |
| [API](docs/API.md) | HTTP API・漫画データ形式・DB保存・AIの共通契約v1 | 画面・API・DBの接続時 |
| [OPERATIONS](docs/OPERATIONS.md) | 認証・個人データ保護・予算管理・公開前チェック | 認証・DB・AI生成・公開を扱う時 |
| [AGENTS](AGENTS.md) | AIコーディングエージェント向けの行動指針 | AIツール利用時 |

### 補助ファイル・テンプレート

- 漫画データの契約（JSON Schema / サンプル）
  - [漫画JSON Schema](docs/contracts/comic.schema.json)
  - [1枚画像方式（page）の例](docs/contracts/comic-page.example.json)
  - [4枚画像方式（panels）の例](docs/contracts/comic-panels.example.json)
  - ※ サンプルはすべて架空データであり、実際の画像は含みません。
- GitHubテンプレート
  - [Pull Requestテンプレート](.github/PULL_REQUEST_TEMPLATE.md)

## 用語

<a id="glossary"></a>

| 用語 | このプロジェクトでの意味 |
|---|---|
| JWT | 認証トークン。署名・発行元・期限等を検証して利用者を特定する |
| RLS | DBの行ごとに読める利用者を制限する仕組み |
| RPC | DB内の関数を呼ぶ仕組み。枠予約等を1トランザクションにまとめる |
| 冪等性 | 同じ操作を再送してもjobや枠を重複作成しない性質 |
| Queue / Consumer | 仕事を渡す待ち行列と、それを受けて実行する処理 |
| claim | 1つのConsumerだけがjobの実行権を取得する操作 |
| unknown | 外部AIで実行・課金されたか判断できないjob状態。自動再生成しない |
| held | unknown等で費用の予約を保持する状態。外部未送信を確認するまで解放しない |
| mock / fixture | 外部サービスの仮実装と、架空の日記・漫画などの固定データ |
| migration | DB構造の変更を順番に再現するファイル |
| revision | 日記の改訂番号。古い画面からの更新の衝突を検出する |
| 秘密情報 | APIキー・認証トークンなど。Supabaseの固有名称だけsecret keyと記す |

## PWAのビルド確認

環境別buildはstaging / productionの架空sample確認に`pnpm build:staging` / `pnpm build:production`、隔離live-demo targetの成果物準備に`pnpm build:demo`を使います。どれも`dist/`の成果物検査までで、Cloudflareへの公開はしません。demo buildには`.env.demo.local`の公開3値が必要です。実デプロイは別途承認後にだけ`pnpm exec wrangler deploy`を手動実行します。対象環境のビルド設定と公開手順は[CONTRIBUTING](CONTRIBUTING.md#環境別ビルド)および[OPERATIONS](docs/OPERATIONS.md#4-環境分離と公開までの手順)を参照してください。

アプリ配信とは別に、Bitwarden接続確認とstaging用の最小Worker初期作成を行う[手動workflow](docs/DEPLOYMENT.md)があります。mergeだけでは起動せず、workers.devとpreview URLを有効にしません。通常CDは後続作業です。

開発サーバーの起動とビルドでは、公開用設定に既知のSupabaseサーバー専用キー形式が入っている場合に処理を停止します。これは既知形式の誤設定対策であり、すべての秘密情報を検出するものではありません。

PWAのビルドとService Workerのキャッシュ範囲、オフライン表示の自動確認には次を実行します。

```sh
pnpm test:e2e:pwa
```

`pnpm build`は、生成したService Workerの事前キャッシュがアプリ画面・バージョン付きJS/CSS・manifest・アイコン・架空サンプルだけであることも検査します。production previewを使う受入テストではCache Storageの対象を確認し、ネットワークを切ってもホーム画面と架空サンプルを表示できることを確認します。個人の日記と生成画像はキャッシュ対象ではありません。

stagingの架空sample画面とPWAをpreviewで確認する場合は、`pnpm build:staging`の後に`pnpm preview`を実行して`http://127.0.0.1:4173`を開きます。通常の`pnpm build`では開発用設定が混ざって`/config`が503になる場合があるため、sample previewには環境別buildを使います。日記保存の確認には、モックなら`pnpm dev`、Supabaseへ保存する場合は[local-connected手順](CONTRIBUTING.md#2-初回起動)に従い`pnpm dev:connected`を使ってください。ローカルの安全な接続として扱われるため、ブラウザの開発者ツールでManifest、Service Worker、Cache Storageを確認できます。

新しい版が利用可能なときは更新案内を表示し、利用者が「更新する」を押した場合にだけ切り替えます。日記の未保存入力中や保存・生成中は更新操作を止め、入力本文を保ちます。previewで更新案内を確認するには、同じURLで一度Service Workerを有効にした後、新しいビルドを配信してアプリを再度開きます。

ローカルpreviewでの確認はAndroid Chrome・iPhone SafariのHTTPS実機確認の代わりにはなりません。実機インストール、standalone表示、更新の確認は公開前に別途行います。

## ライセンス・利用条件

ライセンスは現在未設定です。公開範囲や再利用条件はチームで相談して決定し、あわせて利用する依存ライブラリや生成AIの利用規約も確認します。
