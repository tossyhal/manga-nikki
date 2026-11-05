import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createEntrySchema, jstToday } from '../src/shared/schemas.ts';
import {
  OpenAIScriptProvider,
  openaiScriptModelProfile,
} from '../src/server/ai/openai-script-provider.ts';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      generate: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      date: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      '使い方: node --env-file=.dev.vars scripts/generate-script-openai.ts [日記TXT] [出力JSON] [--date YYYY-MM-DD] [--generate]',
    );
    console.log('既定は入力確認のみ。--generateでOpenAIへ1回送信します。開発サーバーは不要です。');
    return;
  }
  if (positionals.length > 2) throw new Error('引数が多すぎます。--helpを確認してください。');
  const inputPath =
    positionals[0] ??
    fileURLToPath(new URL('../docs/contracts/script.example.txt', import.meta.url));
  const outputPath =
    positionals[1] ??
    fileURLToPath(
      new URL('../docs/contracts/script.example.openai.generated.json', import.meta.url),
    );
  let source: string;
  try {
    source = await readFile(inputPath, 'utf8');
  } catch {
    throw new Error('日記TXTを読み込めません。パスとアクセス権を確認してください。');
  }
  const parsed = createEntrySchema.pick({ body: true, diaryDate: true }).safeParse({
    body: source.replace(/^\uFEFF/, ''),
    diaryDate: values.date ?? jstToday(),
  });
  if (!parsed.success)
    throw new Error('日記は1〜1000文字、日付は未来でないYYYY-MM-DDで指定してください。');
  console.log(`日記の検証に成功しました。モデル: ${openaiScriptModelProfile.modelId}`);
  if (!values.generate) {
    console.log(
      '生成する場合は、予算確認後に --generate を追加してください。API送信・ファイル作成はしていません。',
    );
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim())
    throw new Error('OPENAI_API_KEYがありません。--env-file=.dev.varsで設定を読み込んでください。');
  // 送信前に出力先を確保し、Gemini版や過去の結果を上書きしない。
  let output;
  try {
    output = await open(outputPath, 'wx');
  } catch {
    throw new Error(
      '出力先を作成できません。既存ファイルは上書きしません。別の出力パスを指定してください。',
    );
  }
  try {
    console.log('OpenAI APIへ1回送信します。自動再送は行いません。');
    const script = await new OpenAIScriptProvider(key).createScript(
      {
        id: crypto.randomUUID(),
        ...parsed.data,
        revision: 1,
      },
      {
        signal: AbortSignal.timeout(120_000),
        generationId: crypto.randomUUID(),
        callIndex: 1,
        modelProfile: openaiScriptModelProfile,
      },
    );
    await output.writeFile(JSON.stringify(script, null, 2) + '\n', 'utf8');
    console.log(`検証済みの脚本を保存しました: ${outputPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OPENAI_')) {
      console.error(`脚本生成エラー: ${error.message}`);
    }
    throw new Error(
      '生成・保存を完了できませんでした。出力先に空または不完全なファイルが残る場合があります。APIの利用状況を確認してから手動で対処してください。自動再送はしません。',
    );
  } finally {
    await output.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error && !(error instanceof SyntaxError)
      ? error.message
      : '引数または処理を確認してください。',
  );
  process.exitCode = 1;
}
