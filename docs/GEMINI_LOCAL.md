# Geminiだけで日記から4コマ漫画を生成する

このコマンドはローカルの試作用です。UTF-8の日記TXTから、Geminiで脚本を1回、コマ画像を最大4回生成し、ファイルとして保存します。OpenAI版のコマンド・APIには接続しません。開発サーバーの起動も不要です。

## 準備

リポジトリのルート（`manga-nikki`）で実行します。Node.jsは既存の24.22.1を使います。既存ProviderにTypeScriptのparameter propertiesがあるため、`--experimental-transform-types`が必要です。このフラグに関するNodeの実験的機能の警告が表示されることがあります。依存パッケージの追加はありません。

既存の`.dev.vars`へ、実験に使うキーとフラグを設定します。OpenAI用の設定は残せます。

```dotenv
GEMINI_API_KEY="取得済みのキー"
GEMINI_SCRIPT_ENABLED="true"
GEMINI_IMAGE_ENABLED="true"
GEMINI_IMAGE_BUDGET_APPROVED="true"
```

有効化・予算確認のフラグは、チームで実生成の予算を確認・承認してから設定してください。コードから無料枠・残高・承認を検証することはできません。実装の確認には実AIを使っていません。

- 脚本モデル：`gemini-3.5-flash-lite`。既存の忠実さを重視するプロンプトをそのまま使用します。
- 画像モデル：`gemini-nano-banana-2.1`。1:1、1K、白黒、文字なしの画像を1枚ずつ生成します。このモデルには無料枠がありません。
- 主人公は現在のOpenAI版と合わせ、人間の大学生・短い黒髪・黒い無地のパーカーです。1コマ目を後続の外見参照に使います。外見の完全一致は保証されません。
- caption/dialogueはHTML側に表示します。生成物は画像4枚＋縦4コマ表示のHTMLで、結合PNGは作りません。
- 最大で脚本1回＋画像4回。画像の参照入力にも料金が発生します。日記・脚本・参照画像をGoogleへ送信します。機密情報を含まないテスト日記から始めてください。

利用可能モデル・料金は[公式の画像生成ドキュメント](https://ai.google.dev/gemini-api/docs/image-generation)と[料金表](https://ai.google.dev/gemini-api/docs/pricing)で実行前に確認してください。

## 入力確認

```powershell
node --experimental-transform-types scripts/generate-comic-gemini.ts --date 2026-10-29
```

既定入力は`docs/contracts/script.example.txt`です。入力確認だけならAPIキーも不要で、外部送信・出力フォルダ作成はしません。日記は1〜1000文字、日付は当日以前です。日付を省略すると日本時間の当日を使います。

## 脚本・漫画を一括生成

予算確認と有効化後に実行します。

```powershell
node --experimental-transform-types --env-file=.dev.vars scripts/generate-comic-gemini.ts --date 2026-10-29 --generate
```

別の日記と出力先を指定する場合：

```powershell
node --experimental-transform-types --env-file=.dev.vars scripts/generate-comic-gemini.ts docs/contracts/script.example.txt generated/gemini/my-first-run --date 2026-10-29 --generate
```

出力先を省略すると`generated/gemini/<ランダムID>/`へ保存します。既存の出力フォルダはAPI送信前に拒否し、上書きしません。`generated/`はGitの追跡対象外です。別の場所へ保存した場合は、そのフォルダを誤ってGitへ追加しないでください。

成功時に保存するもの：

| ファイル | 内容 |
|---|---|
| `script.json` | 検証済みの脚本 |
| `panel-1.png`〜`panel-4.png` | 各コマ画像。返却形式に応じてjpg/webpになることもあります |
| `index.html` | 画像とキャプション・セリフを縦に並べた漫画 |
| `result.json` | 生成ID・モデル・状態・画像のファイル名・取得できた使用量・エラーコード |

生成後はローカルのプレビューサーバーが起動します。表示された`http://127.0.0.1:<ポート>/`をブラウザで開くと、OpenAI版と同じレイアウトで漫画全体を確認できます。終了するにはCtrl+Cを押してください。Workerの15分の保存期限はありません。ローカルファイルの削除は手動です。

保存だけしてコマンドを終了する場合は`--no-preview`を追加します。保存済みの漫画をWebページで開き直す場合は、APIを呼ばずに次を実行します。

```powershell
node scripts/preview-comic-gemini.ts generated/gemini/<生成結果ID>
```

このサーバーは127.0.0.1限定で、指定フォルダのindex.htmlとコマ画像だけを配信します。script.json・result.jsonやほかのファイルは配信しません。生成が脚本段階で失敗しindex.htmlがない場合は、まだ漫画ページを表示できません。

## 失敗時

脚本を保存してから画像生成へ進みます。画像生成でエラーが返った場合は、それまでに取得できた画像も保存し、`index.html`で確認できます。脚本生成で失敗した場合は画像を呼び出しません。APIや保存が失敗した場合は終了コード1です。

SDK・コマンドともに自動再送は行いません。通信切断後は、API側で実行・課金された可能性があります。`result.json`とAI Studioの利用状況を確認してください。再実行すると脚本から生成し直すため、別の出力先にしても追加の費用が発生します。プロセスの強制終了時は取得中の画像を回収できず、`result.json`が`running`のまま残る場合があります。保存エラーでは保存できた範囲のファイルだけが残ります。

これはローカルCLI用の保存処理です。Web画面、公開API、Queue、SupabaseのDB/Storage保存、予算台帳には接続しません。既存の`generate-script-openai.ts`と`render-comic.ts`は従来どおりOpenAI版として利用できます。


## カラー版を試す

白黒版の`generate-comic-gemini.ts`はそのまま残しています。カラー版は別のコマンドです。
キーと有効化・予算確認の環境変数は白黒版と共通で、実生成にはAPI利用料金が発生します。

```powershell
# 入力確認だけ。APIには送信しません。
node --experimental-transform-types scripts/generate-comic-gemini-color.ts

# 日記から脚本とカラー漫画を生成し、Webプレビューを起動します。
node --experimental-transform-types --env-file=.dev.vars scripts/generate-comic-gemini-color.ts --generate
```

既定の入力は白黒版と同じ`docs/contracts/script.example.txt`です。
出力は`generated/gemini-color/<ID>/`に分け、白黒版の結果は上書きしません。
保存済みカラー漫画は`node scripts/preview-comic-gemini.ts generated/gemini-color/<ID>`で開き直せます。
カラー指定以外は同じ画像モデル・主人公・外見参照・文字の表示方式を使います。
`result.json`の`colorMode`が`color`ならカラー版、`monochrome`なら白黒版です。
過去の記録にはこの項目がありません。
カラー版も日記から脚本を作り直すため、白黒版と構図や脚本が完全に一致する比較ではありません。
実装確認では実AIの生成は行っていません。
