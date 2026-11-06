# 漫画日記のアーキテクチャ図

![漫画日記のシステム構成](architecture.png)

[ライトPNG](architecture.png)／[ダークPNG](architecture-dark.png)／[編集用HTML](architecture.html)

利用者のスマートフォンから、Cloudflare Workerでの受付、Queueを介した非同期生成、OpenAIの呼び出し、Supabaseへの保存までを1枚に示します。

- 青い実線：日記から漫画を生成する主経路
- 灰色の実線：認証、読み取り、署名URL、定期処理
- 灰色の破線：デプロイ時の関係

## 図の読み方

画面配信、Hono API、Queue Consumer、Cronは1つのWorkerで動きます。図では役割ごとにノードを分け、`Worker`の枠で同一デプロイであることを示しています。画面の静的ファイルはWorkerのassetsから配信し、`/api/*`だけをHonoへ渡します。

ブラウザからSupabaseへ直接通信するのは、匿名サインインと署名URLでの画像取得です。日記の読み書きや生成枠の予約はHono APIを経由し、読み取りは利用者JWTとRLS、書き込みはサーバー専用RPCを使います。

署名URLは有効期間中、URLを知っている人が利用できます。そのため図では「本人だけが閲覧できる」とは表現していません。Queueの重複配信はclaim RPCで抑止しますが、二重課金の完全な防止を保証するものではありません。

次の項目は図から省略しています。

- CronからStorageへの期限削除の通信
- Workerの動作モードと、生成を有効にする条件
- stagingなど環境ごとの差分
- Bitwarden以外の秘密情報の配置

環境別の構成は[ARCHITECTURE](../ARCHITECTURE.md)、[PRODUCTION_DEPLOYMENT](https://github.com/tossyhal/manga-nikki/blob/develop/docs/PRODUCTION_DEPLOYMENT.md)を参照してください。

## 編集と再生成

`architecture.html`が正本です。ロゴと欧文フォントを埋め込んでおり、ネットワークなしで開けます。日本語は端末の日本語フォントで表示します。図中の座標、ラベル、SVGの矢印を編集した後、stack-diagramの公式スクリプトでPNGを書き出します。

```sh
git clone https://github.com/caru-ini/stack-diagram.git /tmp/stack-diagram
git -C /tmp/stack-diagram checkout 1ed53e3e9525364ae5d82e0430f2bb3f7ef4c838
uv run --no-project --with playwright==1.64.1 python -m playwright install chromium
uv run --no-project --with playwright==1.64.1 python \
  /tmp/stack-diagram/skills/stack-diagram/scripts/render_png.py \
  docs/diagrams/architecture.html docs/diagrams/architecture.png \
  --selector .canvas --scale 2
```

ライトとダークの2枚が出力されます。Python3.9以上、uv、Noto Sans CJK JPなどの日本語フォントが必要です。アプリ側の依存関係への追加は不要です。

## 構成の参照元

参照コミットは`origin/develop`の`5929b65`です。主な照合先は`wrangler.jsonc`、`src/server/index.ts`、`src/server/live-generations.ts`、`src/server/generation-queue.ts`、`src/server/scheduled-handler.ts`、`src/client/lib/auth.ts`、`src/build/production-connected-deployment.ts`、`.github/workflows/ci.yml`、`.github/workflows/database-migrate.yml`です。

## 出典とライセンス

- テンプレートと描画：[caru-ini/stack-diagram](https://github.com/caru-ini/stack-diagram/tree/1ed53e3e9525364ae5d82e0430f2bb3f7ef4c838/skills/stack-diagram)、[MITライセンス](licenses/stack-diagram.txt)
- React、Hono、Cloudflare、Supabase、PostgreSQL、OpenAI、Bitwardenのロゴ：[svgl](https://svgl.app/)
- GitHub Actionsのロゴ：[gilbarbara/logos](https://github.com/gilbarbara/logos)
- 利用者、Cron、Consumerの図記号：[Lucide](https://lucide.dev/)、[ISCライセンス](licenses/lucide.txt)
- 埋め込みフォント：[GeistのOFL](licenses/OFL-Geist.txt)、[JetBrains MonoのOFL](licenses/OFL-JetBrainsMono.txt)

各ロゴの権利は各所有者に帰属します。
