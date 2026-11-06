# 漫画日記 / manga-nikki

書いた日記を、読み返したくなる4コマに。

日記をAIで4コマ漫画に変換して保存・閲覧できる、スマートフォン向けPWAです。
技育CAMP2026ハッカソンVol.6にて、チーム「27卒」が開発します。

> 現在の状態（2026-11-05時点）
> PR#29までの変更は`main`へ統合済みです。現在のPR#41ではOpenAI白黒生成のQueue接続と保存復旧経路まで実装しています。段階ごとの詳細は[PLAN](docs/PLAN.md)を参照してください。
>
> 匿名Auth・日記CRUD/編集・RLS/RPC、原子的な生成枠予約とclaim / attempt / lease / unknown、固定mock Queue経路、CAPTCHA・利用枠UI、PWA、Storage先行の期限削除、環境別sample buildと公開設定guardを実装しています。PR#41ではOpenAIの脚本・白黒画像provider、profile制約、各API呼出しのattempt ledger、live Queue runnerと保存復旧callback契約を追加しています。local-mockでは日記→固定漫画→仮保存→再読込を確認できます。保存先は開発Workerのメモリで、再起動やコード変更で消える場合があります。local-connectedでは固定mockの画像URLに公開の架空サンプルを返します。staging/productionの`sample` modeと不正なmodeは個人DBへ接続しません。生成画像のprivate Storage保存・assets登録・実生成のsucceeded確定RPCは未実装です。保存handlerまたは復旧callbackが未設定なら新規実AI生成を停止します。すでにqueuedのjobと`reserved`枠はreleaseせず保持し、ready復帰後にreconcileから再送します。保存復旧は元claim deadlineから24時間以内、5分backoff、Cron1回最大3件・各120秒です。復旧callback未設定や24時間経過後は自動復旧しません。実AI課金・アカウント権限・品質、共有DBへのmigration適用、実Turnstile・実Cloudflare Queue / Cron、最新branchの全経路は未確認です。

> 以前、隔離Supabase CLI / PostgreSQL / Auth / PostgREST / StorageとローカルQueueで、匿名Auth A/B、日記作成・再取得・PATCH競合・他owner拒否、service fixtureからの固定mock Consumer、Storage→DB期限削除service、一部Storage RLSを確認しました。これは部分的な過去検証で、実Turnstile・共有DB・実Cloudflare Queue / Cron・HTTPSスマホ実機や、最新branchの全経路を確認したものではありません。この文書同期では再実行していません。

日記DBのmigration・RLS・日記操作用RPC・生成由来metadataと隔離PostgreSQLテストがあります。共有DBへのmigration適用と実クラウド環境での結合確認は未実施です。過去の隔離環境による部分検証の範囲は[supabase/README.md](supabase/README.md)を参照してください。

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

環境別のbuildは`pnpm build:staging`または`pnpm build:production`で行います。ローカル実行は成果物検査まででCloudflareへ公開しません。`develop`へのpush後、CIのdatabase/checkが成功し、所有者がRepository variable`STAGING_SAMPLE_CD_ENABLED=true`を設定した場合だけ、stagingへ架空sampleを配信します。既定は無効です。stagingは公開workers.dev URLで、個人DB/Auth/Turnstile・実AI・Queue/Cronを使いません。本番の配信はこのworkflowに含めず、別承認が必要です。対象環境の手順は[CONTRIBUTING](CONTRIBUTING.md#環境別ビルド)・[OPERATIONS](docs/OPERATIONS.md#4-環境分離と公開までの手順)・[DEPLOYMENT](docs/DEPLOYMENT.md)を参照してください。

stagingのsample公開先は[workers.dev URL](https://manga-nikki-staging.tossyhal.workers.dev)です。Repository variable`STAGING_SAMPLE_CD_ENABLED`が未設定のため、sample CDはまだ有効化されていません。有効化に必要なGitHub Ruleset・Environment・Bitwarden設定は[DEPLOYMENT](docs/DEPLOYMENT.md)に記録しています。初期作成用workflowと資格情報は退役済みです。

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
