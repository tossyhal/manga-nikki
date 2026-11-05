import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createEntrySchema, jstToday } from '../src/shared/schemas.ts';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      generate: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      'no-preview': { type: 'boolean', default: false },
      date: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      '使い方: node --experimental-transform-types --env-file=.dev.vars scripts/generate-comic-gemini-color.ts [日記TXT] [新規出力フォルダ] [--date YYYY-MM-DD] [--generate] [--no-preview]',
    );
    console.log(
      'Geminiのみで脚本1回＋カラー画像最大4回を生成します。開発サーバー不要。既定は入力確認のみです。',
    );
    return;
  }
  if (positionals.length > 2) throw new Error('引数が多すぎます。--helpを確認してください。');
  const inputFile =
    positionals[0] ??
    fileURLToPath(new URL('../docs/contracts/script.example.txt', import.meta.url));
  let source: string;
  try {
    source = await readFile(inputFile, 'utf8');
  } catch {
    throw new Error('日記TXTを読み込めません。パスとアクセス権を確認してください。');
  }
  const diary = createEntrySchema
    .pick({ body: true, diaryDate: true })
    .safeParse({ body: source.replace(/^\uFEFF/, ''), diaryDate: values.date ?? jstToday() });
  if (!diary.success)
    throw new Error('日記は1〜1000文字、日付は未来でないYYYY-MM-DDで指定してください。');
  const outputDirectory = resolve(
    positionals[1] ??
      fileURLToPath(new URL(`../generated/gemini-color/${crypto.randomUUID()}/`, import.meta.url)),
  );
  console.log('日記の検証に成功しました。');
  console.log(`出力先: ${outputDirectory}`);
  if (!values.generate) {
    console.log(
      '入力確認のみです。API送信・ファイル作成はしていません。生成時は予算確認後に --generate を追加してください。',
    );
    return;
  }
  if (!process.env.GEMINI_API_KEY?.trim())
    throw new Error('GEMINI_API_KEYがありません。--env-file=.dev.varsで読み込んでください。');
  if (
    process.env.GEMINI_SCRIPT_ENABLED !== 'true' ||
    process.env.GEMINI_IMAGE_ENABLED !== 'true' ||
    process.env.GEMINI_IMAGE_BUDGET_APPROVED !== 'true'
  )
    throw new Error(
      'Geminiの脚本・画像生成が未有効か予算が未確認です。GEMINI_SCRIPT_ENABLED / GEMINI_IMAGE_ENABLED / GEMINI_IMAGE_BUDGET_APPROVEDを確認してください。',
    );
  const { generateGeminiComic } = await import('../src/server/ai/gemini-comic-runner.ts');
  console.log('Geminiで脚本とカラー画像を生成します。自動再送やOpenAIへの切り替えは行いません。');
  const result = await generateGeminiComic({
    ...diary.data,
    outputDirectory,
    apiKey: process.env.GEMINI_API_KEY,
    colorMode: 'color',
    signal: AbortSignal.timeout(600_000),
  });
  console.log(`保存できたコマ数: ${result.panels.length} / 4`);
  if (result.scriptFile) console.log(`脚本: ${resolve(outputDirectory, result.scriptFile)}`);
  if (result.previewFile) console.log(`漫画HTML: ${resolve(outputDirectory, result.previewFile)}`);
  console.log(`実行記録: ${resolve(outputDirectory, 'result.json')}`);
  if (result.error?.diagnostics) {
    const diagnostics = result.error.diagnostics;
    console.error(
      `診断: HTTP ${diagnostics.providerStatus ?? '不明'}, API状態 ${diagnostics.apiStatus ?? '不明'}, 原因区分 ${diagnostics.reason}, モデル ${diagnostics.modelId}`,
    );
  } else if (result.error?.providerStatus) {
    console.error(`診断: HTTP ${result.error.providerStatus}`);
  }
  if (result.previewFile && !values['no-preview']) {
    const { startComicPreview } = await import('../src/server/local-comic-preview.ts');
    const preview = await startComicPreview(outputDirectory);
    console.log(`プレビュー: ${preview.url}`);
    console.log('ブラウザで開いてください。プレビューを終了するにはCtrl+Cを押してください。');
  }
  if (result.status !== 'succeeded')
    throw new Error(
      `生成・保存が完了しませんでした（${result.error?.code ?? 'LOCAL_GENERATION_FAILED'}）。完成済みデータとAI Studioの利用状況を確認してください。自動再送はしません。`,
    );
}

try {
  await main();
} catch (error) {
  const localCode = error as { code?: unknown } | null;
  if (localCode?.code === 'EEXIST')
    console.error(
      '出力フォルダが既に存在します。上書きせず停止しました。別の新規フォルダを指定してください。',
    );
  else if (localCode?.code)
    console.error(
      'ファイル操作に失敗しました。保存先と権限を確認してください。送信後の場合は利用状況を確認し、むやみに再実行しないでください。',
    );
  else
    console.error(
      error instanceof Error && !(error instanceof SyntaxError)
        ? error.message
        : '引数または処理を確認してください。',
    );
  process.exitCode = 1;
}
