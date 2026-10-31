import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scriptSchema } from '../src/server/ai/script-schema.ts';

// 引数を省略した場合は、保存済みの大学祭のサンプルを検証する。
const defaultPath = fileURLToPath(
  new URL('../docs/contracts/university-festival.script.example.json', import.meta.url),
);
const args = process.argv.slice(2);

async function main() {
  if (args.length > 1) {
    console.error('使い方: node scripts/validate-script.ts [脚本JSONのパス]');
    process.exitCode = 1;
    return;
  }

  let source: string;
  try {
    source = await readFile(args[0] ?? defaultPath, 'utf8');
  } catch {
    console.error('ファイルを読み込めません。パスとアクセス権を確認してください。');
    process.exitCode = 1;
    return;
  }

  let input: unknown;
  try {
    // UTF-8のBOMが付いたファイルも受け付ける。
    input = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    console.error('JSONの構文が不正です。引用符、カンマ、括弧を確認してください。');
    process.exitCode = 1;
    return;
  }

  const result = scriptSchema.safeParse(input);
  if (!result.success) {
    console.error('検証失敗：脚本の形式が仕様に合っていません。');
    for (const issue of result.error.issues) {
      console.error(`- ${issue.path.join('.') || '(全体)'}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('検証成功：タイトルと4コマの脚本は正しい形式です。');
  console.log('※日記への忠実さや漫画としての面白さは、この検証の対象外です。');
}

await main();
