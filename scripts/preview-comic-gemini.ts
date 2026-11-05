import { resolve } from 'node:path';
import { startComicPreview } from '../src/server/local-comic-preview.ts';

if (process.argv.length !== 3) {
  console.error('使い方: node scripts/preview-comic-gemini.ts generated/gemini/<生成結果ID>');
  process.exitCode = 1;
} else {
  try {
    const preview = await startComicPreview(resolve(process.argv[2]!));
    console.log(`プレビュー: ${preview.url}`);
    console.log(
      'ブラウザで開いてください。終了するにはCtrl+Cを押してください。AIへの送信は行いません。',
    );
  } catch {
    console.error('漫画ページを開けません。index.htmlがある生成結果フォルダを指定してください。');
    process.exitCode = 1;
  }
}
