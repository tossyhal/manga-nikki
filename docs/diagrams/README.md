# 漫画日記のアーキテクチャ図

[PNGを開く](architecture.png)／[編集用HTMLを開く](architecture.html)

発表用のライトモード・横長1枚（PNG：3200×1800、16:9）です。日記の入力から、非同期での脚本・画像生成、非公開保存までの主な流れを示します。ボックス内の説明は役割を中心に1〜2行へ絞っています。

定期処理、開発・デプロイ、認証トークンや画像閲覧の細かな通信経路は図から省略しています。OpenAIの呼び出しと画像の保存はConsumerが担当します。「技術的な工夫」の別枠やAppendixは設けていません。アプリの実装や設定は変更していません。

## 編集と再生成

`architecture.html`が正本です。ロゴと欧文フォントを埋め込んでおり、ネットワークなしで開けます。日本語は端末の日本語フォントで表示します。図中の座標・ラベル・SVGの矢印を編集した後、stack-diagramの公式スクリプトでPNGを書き出します。

```sh
git clone https://github.com/caru-ini/stack-diagram.git /tmp/stack-diagram
git -C /tmp/stack-diagram checkout 1ed53e3e9525364ae5d82e0430f2bb3f7ef4c838
uv run --no-project --with playwright==1.56.0 python -m playwright install chromium
uv run --no-project --with playwright==1.56.0 python \
  /tmp/stack-diagram/skills/stack-diagram/scripts/render_png.py \
  docs/diagrams/architecture.html docs/diagrams/architecture.png \
  --selector .canvas --scale 2 --single
```

Python3.9以上、uv、Chromiumの実行に必要なOSライブラリ、日本語フォントが必要です。描画時はNoto Sans CJK JPなどの日本語フォントを用意してください。初回の取得・導入にはネットワーク接続が必要です。アプリ側の依存関係への追加は不要です。

## 構成の参照元

アプリの参照コミットは`909ee02`です。主な照合先は`src/server/index.ts`、`src/server/auth.ts`、`src/server/live-generations.ts`、`src/server/generation-queue.ts`、`src/server/comic-save-runtime.ts`、`src/server/ai/openai-*-provider.ts`、`src/client/lib/auth.ts`です。

APIとQueue Consumerは同一Workerの処理です。Supabaseへの読み取りは利用者JWTとRLS、書き込み・生成枠の予約はサーバー専用RPCを使います。画像はprivate Storageへ保存し、所有者確認後に短命の署名URLを発行します。署名URLは有効期間中、そのURLを知っている人が利用できるため、図では「本人だけが閲覧できる」とは表現していません。重複配信への対策も、二重課金の完全防止を保証する表現にはしていません。

## 出典とライセンス

- テンプレート・描画：[caru-ini/stack-diagram](https://github.com/caru-ini/stack-diagram/tree/1ed53e3e9525364ae5d82e0430f2bb3f7ef4c838/skills/stack-diagram)、[MITライセンス](licenses/stack-diagram.txt)。
- React、Hono、Cloudflare、Supabase、OpenAIのロゴ：[svgl](https://svgl.app/)。各ロゴの権利は各所有者に帰属します。
- 非同期処理の図記号：[Lucide](https://lucide.dev/)、[ISCライセンス](licenses/lucide.txt)。
- 埋め込みフォント：GeistとJetBrains Mono。[GeistのOFL](licenses/OFL-Geist.txt)／[JetBrains MonoのOFL](licenses/OFL-JetBrainsMono.txt)。
