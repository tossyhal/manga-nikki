import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { scriptSchema } from '../src/server/ai/script-schema.ts';

const defaultPath = fileURLToPath(
  new URL('../docs/contracts/script.example.openai.generated.json', import.meta.url),
);
const args = process.argv.slice(2);
const generate = args.includes('--generate');
const paths = args.filter((arg) => !arg.startsWith('--'));

async function main() {
  if (args.includes('--help')) {
    console.log('使い方: node scripts/render-comic.ts [脚本JSON] [--generate]');
    console.log('既定は脚本検証のみ。--generateでローカルAPIへ1回送信し、画像生成を開始します。');
    return;
  }
  if (paths.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--generate')) {
    throw new Error('引数を確認してください。--helpで使い方を表示できます。');
  }

  let data: unknown;
  try {
    const source = await readFile(paths[0] ?? defaultPath, 'utf8');
    data = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('脚本ファイルを読めません。パス、文字コード、JSON構文を確認してください。');
  }
  const parsed = scriptSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join('.') || '(全体)'}: ${issue.message}`);
    }
    throw new Error('脚本の形式が仕様に合っていません。');
  }
  console.log('脚本の検証に成功しました。');
  if (!generate) {
    console.log('生成する場合は、予算確認後に同じコマンドへ --generate を追加してください。');
    return;
  }

  console.log('ローカルAPIに送信します。画像生成は最大4回です。');
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:5173/api/v1/dev/openai-comics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-OpenAI': '1' },
      body: JSON.stringify({ script: parsed.data }),
      signal: AbortSignal.timeout(600_000),
      redirect: 'error',
    });
  } catch {
    throw new Error(
      'APIに接続できないか、結果を受信できませんでした。開発サーバーとOpenAI API Platformの利用状況を確認してください。送信後の場合は実行済みの可能性があります。',
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('APIの返答がJSONではありません。接続先とサーバーの状態を確認してください。');
  }
  const receipt = z
    .object({
      status: z.enum(['succeeded', 'failed']),
      previewUrl: z.string().regex(/^\/api\/v1\/dev\/openai-comics\/[0-9a-f-]+\/view$/),
      panels: z.array(z.object({ index: z.number().int().min(1).max(4) })),
    })
    .safeParse(result);
  if (receipt.success) {
    console.log(`取得できたコマ数: ${receipt.data.panels.length} / 4`);
    console.log(`プレビュー: http://127.0.0.1:5173${receipt.data.previewUrl}`);
    console.log('プレビューは生成終了から15分間だけ保持されます。');
    if (response.ok && receipt.data.status === 'succeeded' && receipt.data.panels.length === 4) {
      return;
    }
  }

  const failure = z
    .object({ error: z.object({ code: z.string().regex(/^[A-Z_]+$/) }) })
    .safeParse(result);
  const code = failure.success ? failure.data.error.code : 'INVALID_RESPONSE';
  if (code === 'IMAGE_QUOTA_EXCEEDED') {
    console.error(
      'OpenAI APIのクレジット不足または利用額上限です。APIキーの所属組織のBilling残高とLimitsを確認してください。',
    );
  } else if (code === 'IMAGE_RATE_LIMIT') {
    console.error(
      'OpenAIが429を返しました。API PlatformのLimitsとBillingを確認してください。詳細コードがない場合は、利用頻度と残高のどちらが原因か確定できません。',
    );
  }

  throw new Error(
    `生成が完了しませんでした（HTTP ${response.status}, ${code}）。成功済み画像は表示されたプレビューで確認できます。自動再送は行いません。`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '処理に失敗しました。');
  process.exitCode = 1;
}
