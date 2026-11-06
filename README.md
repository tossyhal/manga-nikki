# 漫画日記 / manga-nikki

書いた日記を、読み返したくなる4コマに。

日記をAIで4コマ漫画に変換して保存・閲覧する、スマートフォン向けPWAです。
技育CAMP2026ハッカソンVol.6でチーム「27卒」が開発しました。

漫画は文字を含むPNGとして保存できます。「URLで共有」から選んだ漫画だけを公開すると、URLを知っている人がログインなしで閲覧できます。日記本文は共有せず、元の日記の削除・保存期限で共有も終了します。

## 公開先

- [本番](https://manga-nikki.tossyhal.workers.dev)：匿名認証・日記保存・実AI生成
- [staging](https://manga-nikki-staging.tossyhal.workers.dev)：架空サンプル専用、生成停止

本番はSupabase Auth/DB/private Storage、Turnstile、OpenAI、Cloudflare Queueへ接続します。
現在の配信commitは各URLの`/__deployment.json`で確認できます。
AIエージェントは課金生成を実行しません。予算・公開条件の変更には別承認が必要です。

## 起動

Gitとmiseを用意し、設定を確認してから実行します。
既存のローカル設定は上書きしないでください。

```sh
mise trust
mise install --locked
pnpm install --frozen-lockfile
cp .env.example .env.local
cp .dev.vars.example .dev.vars
pnpm dev
```

Windows PowerShellでは`cp`を`Copy-Item`へ置き換えられます。
初期設定は外部サービスへ接続しないモックです。詳細と接続版は[開発手順](CONTRIBUTING.md)を参照してください。

## 実装を読む

仕様・設定・契約の正本はコードです。採用版は[package.json](package.json)とlockfile、環境構成は[wrangler.jsonc](wrangler.jsonc)を参照してください。

| 入口 | 内容 |
|---|---|
| [src/client](src/client) | React・React Routerの画面、PWA、認証とAPI呼出し |
| [src/server/index.ts](src/server/index.ts) / [app.ts](src/server/app.ts) | Cloudflare Worker・HonoのHTTP、Queue、Cron |
| [src/server/ai](src/server/ai) | OpenAI脚本・画像生成と固定モック |
| [src/shared/schemas.ts](src/shared/schemas.ts) | Zodによる入力と共有データ契約 |
| [supabase/migrations](supabase/migrations) | PostgreSQLのschema・RLS・RPC |
| [docs/contracts](docs/contracts) | テスト対象の漫画JSON Schemaと架空fixture |
| [.github/workflows](.github/workflows) / [scripts](scripts) | CI、配信、DB操作と検査 |
| [design](design) | デザイン参照画像・SVG・プレビュー資産 |

## 開発・運用

- [CONTRIBUTING.md](CONTRIBUTING.md)：起動、検査、ブランチとPR
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：秘密情報、配信、生成停止、DB変更と復旧
- [supabase/README.md](supabase/README.md)：隔離DBテストとDBコードの入口
- [構成図](docs/diagrams/README.md)：発表用PNGと編集用HTML
- [AGENTS.md](AGENTS.md)：コーディングエージェントの作業規約

<a id="glossary"></a>

`unknown`は外部AIで実行・課金されたか判断できない生成状態です。自動再生成せず、`held`として費用の予約を保持します。
冪等性は同じ要求の再送で生成や枠予約を重複させない性質、RLSはDBの行ごとのアクセス制限、RPCはDB内の関数呼出しです。

ライセンスは未設定です。再利用条件と生成AIの利用規約は、利用前に確認してください。
