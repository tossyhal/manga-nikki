# Codex / Claude Code 用プロンプト（そのまま貼り付け）

`design-handoff/README_FIRST.md` と `design-handoff/DESIGN_SPEC.md`、`design-handoff/screen_manifest.json` を読み、`design-handoff/reference/browser_content/` のPNG画像（30画面）を見て、既存の漫画日記アプリのUIを忠実に実装してください。

**最重要：本プロジェクトは既にReact/TypeScript/React Router/Tailwind/Playwrightで動いています。UIの置き換えだけを行い、API・認証・Queue・生成費用上限・データ型・セキュリティルール・現行テストは壊さないこと。** 対象ファイルとコンポーネントの既存実装をまず確認し、どこを再利用し何を置き換えるか説明してください。必要なUI作業は実際に実装し、TODOだけ残さないでください。

## Source of truth
- 視覚：`design-handoff/reference/browser_content/*.png`、元画像は`reference/screens/*.png`。
- 色・余白・CTA/ナビ形状・UX：`design-handoff/DESIGN_SPEC.md` と `design_tokens.json`。
- 状態とルート：`screen_manifest.json`。30独立ページではなく4ルート＋状態差分。
- 単体の猫・漫画素材：`design-handoff/assets/*.svg`。
- SVG画面全体：寸法確認用。完成画面をSVG丸ごと埋め込んだ実装は絶対禁止。
- 既存のAPI契約・認証・利用制限：リポジトリの現在のコード・docs/API.md・docs/OPERATIONS.mdを維持。

## 目標UI
1. ミニマルなモノクロ。白背景／`#F6F6F6`カード／`#222222`CTA／Noto Sans JP。
2. ナビは「ホーム／＋／カレンダー」。選択中だけアイコンの**下**にラベル。選択セグメントの内側は直線で、外側だけ親の角丸に沿う。
3. 主CTAは原則ナビ直上、間隔約14px。下書き保存は日記入力右上、削除は詳細の「…」メニューに移動。
4. 生成中 queued/script/images/saving・unknown/failed/cancelled・quota/offline・下書き/保存失敗・カレンダー空状態などをデータの実状態で分岐。
5. `visual.kind=page` / `panels` をどちらも表示。実生成画像を使える場合はその画像を表示。
6. iOSのステータスバー `9:41` とホームインジケータは参考画像に含まれる**モックの装飾**であり、PWAに実装しない。
7. 操作要素はbutton/input/textarea等で実装し、アクセシビリティラベルとフォーカス表示を持たせる。

## 作業プロセス
A. 既存の画面、ルーティング、データ型、Playwrightのfixture/テスト環境を調査。
B. まず共通 `AppShell / BottomNav / PrimaryCTA / DiaryCard / ComicPanel / ComicViewer / StatusView / Modal` を作り、モックデータで4つの基本画面を仕上げる。
C. 実APIと統合し、状態別UIを描画。生成失敗時・通信断時でも日記本文を保持し、重複生成しない。
D. Playwrightで390pxのスクリーンショットを撮り、`reference/browser_content`と視覚比較して修正。基準PNGは縦769px、OS装飾の除外済み。テスト時は固定データ/時刻/フォントで画面を安定化。
E. 少なくともホーム・入力・カレンダー・漫画完成・生成中・失敗を確認し、320px/430pxとiPhoneのセーフエリア・キーボードも確認。
F. `pnpm lint`、`pnpm typecheck`、関連単体/E2Eテストを実行。既存テストは破壊しない。
G. 最後に変更ファイル一覧・比較スクリーンショット・残った差分・実際に確認したコマンドを報告。デザインと違うと判断したところを勝手に追加せず、簡潔に理由を説明。

**絶対禁止**：全画面SVG/PNGを `<img>` にして「実装完了」とすること、コンポーネントを全部absolute座標で組み立てること、ボタンを見た目だけの飾りにすること、実際の状態を偽のタイマーで進めること、APIの認証/回数制限を外すこと。
