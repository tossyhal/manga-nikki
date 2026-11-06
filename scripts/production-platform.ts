import { appendFile } from 'node:fs/promises';
import {
  ProductionPlatformFailure,
  gateProductionPlatform,
  runProductionPlatform,
} from '../src/build/production-platform.ts';
import { ProductionSamplePreflightFailure } from '../src/build/production-sample-preflight.ts';

async function main(): Promise<void> {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--gate-only') || process.argv.length > 3)
      throw new ProductionPlatformFailure('PLATFORM_INPUT_INVALID');
    const operation = await gateProductionPlatform(process.env);
    if (process.argv[2] === '--gate-only') return;
    const result = await runProductionPlatform({
      operation,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
      supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',
      supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
    });
    const summary = [
      '## 本番生成platform',
      '',
      `- Operation: \`${operation}\``,
      `- Queue: \`${result.queue}\``,
      `- Private comics bucket: \`${result.bucket}\``,
      `- Cron configuration: \`${result.cron}\``,
      `- Storage dummy fixture probe: \`${result.storageProbe}\``,
      `- Storage policy metadata: \`${result.storagePolicies}\``,
      '- この結果だけでは生成有効化の条件を満たしません。DB metadata jobも必須です。',
      '- AI呼出し・予算・Worker設定は変更していません。Cron実行結果は別途未検証です。',
      '',
    ].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, { mode: 0o600 });
    if (result.queue === 'permission-required' || result.queue === 'missing') {
      console.error(
        `production-platform: ${result.queue === 'permission-required' ? 'QUEUE_PERMISSION_REQUIRED' : 'QUEUE_MISSING'}`,
      );
      process.exitCode = 1;
    } else {
      console.log('production-platform: PLATFORM_CHECK_FINISHED');
    }
  } catch (error) {
    const code =
      error instanceof ProductionPlatformFailure ||
      error instanceof ProductionSamplePreflightFailure
        ? error.code
        : 'INTERNAL_ERROR';
    console.error(`production-platform: ${code}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## 本番生成platform\n\n- Result: failed\n- Code: \`${code}\`\n- 書込開始後の失敗・中断は自動再実行せず状態を再確認します。\n`,
        { mode: 0o600 },
      );
    process.exitCode = 1;
  }
}
await main();
