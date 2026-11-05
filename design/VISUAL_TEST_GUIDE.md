# スクリーンショット差分検証手順

> 既存の Playwright E2E テストを利用してください。以下は概念例です。既存アプリで再現できる固定モックデータ/ルートへ置き換える必要があります。

```ts
import { test } from '@playwright/test';

test('home visual reference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 769 });
  // TODO: テスト用fixtureで「ホーム/今日の記録なし」を再現すること。
  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/visual/home.png' });
});
```

撮影した画像を比較：

```sh
python design-handoff/tools/visual_diff.py \
  design-handoff/reference/browser_content/01.png \
  artifacts/visual/home.png \
  --out artifacts/visual/home-diff.png
```

「画像のMAEを最小化するだけ」で正常なHTMLや操作性を犠牲にしないでください。比較すべき領域は文字組み・横余白・カード/CTA・ナビなど。日付/サムネイルはテストの固定fixtureで一致させます。Safari standalone・Androidブラウザでは `safe-area-inset-*` やソフトキーボードが異なるため別途実機確認します。
