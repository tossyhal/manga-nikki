# 漫画日記 / manga-nikki

書いた日記を、読み返したくなる4コマに。

日記をAIで4コマ漫画に変換して保存・閲覧できる、スマートフォン向けPWAです。
技育CAMP2026ハッカソンVol.6にて、チーム「27卒」が開発します。

> 現在の状態（2026-11-04時点）
> localhost限定の開発用モック基盤と、liveモードの日記CRUD接続があります。local-mockでは日記→固定漫画→仮保存→再読込を確認できます。保存先は開発Workerのメモリで、再起動やコード変更で消える場合があります。liveモードはJWT検証、Supabase DBの日記一覧・詳細・作成・編集・削除を実装済みです。生成のDB実行claim・provider attempt・失敗時の安全精算RPC、期限切れ日記のStorage→DB物理削除RPC・server専用cleanup serviceも追加済みですが、生成受付・quota・`/generations/:id`・画像保存/署名URL・Queue・実AI・PWAとcleanup serviceの定期呼出接続は未実装です。Storage bucket設定はStorage APIを含むSupabase環境で別SQLを適用します。

日記DBのmigration・RLS・日記操作用RPC・生成由来metadataと隔離PostgreSQLテストがあります。JWT検証はSupabase SDKと偽JWKSを使ったローカルテストで確認していますが、実プロジェクトへの接続・共有DBへの適用は未実施です。接続契約と検証手順は[supabase/README.md](supabase/README.md)を参照してください。

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

## ライセンス・利用条件

ライセンスは現在未設定です。公開範囲や再利用条件はチームで相談して決定し、あわせて利用する依存ライブラリや生成AIの利用規約も確認します。
