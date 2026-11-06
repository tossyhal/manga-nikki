import { appendFile } from 'node:fs/promises';
import { PRODUCTION_SAMPLE_PROFILE } from '../src/build/sample-deployment.ts';
import {
  checkProductionSamplePreflight,
  ProductionSamplePreflightFailure,
} from '../src/build/production-sample-preflight.ts';

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    const result = await checkProductionSamplePreflight({
      githubActions: process.env.GITHUB_ACTIONS,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubSha: process.env.GITHUB_SHA,
      githubActorId: process.env.GITHUB_ACTOR_ID,
      githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
      githubToken: process.env.GITHUB_TOKEN,
      workerUrl: process.env.PRODUCTION_WORKER_URL,
      productionSampleCdEnabled: process.env.PRODUCTION_SAMPLE_CD_ENABLED,
      bwsCloudflareSecretId: process.env.BWS_CLOUDFLARE_SECRET_ID,
    });
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.deployment === 'ready'}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    if (result.deployment === 'skipped' && process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## Production sample CD',
          '',
          '- Environment: `production`',
          `- Commit: \`${result.commit}\``,
          `- URL: ${PRODUCTION_SAMPLE_PROFILE.workerUrl}`,
          '- Deploy: `skipped`',
          `- Skip reason: ${result.skipReason === 'flag-disabled' ? 'production Environment flagが有効ではありません' : '実行SHAが現在のmain HEADと一致しません'}`,
          '- Smoke: `not-run`',
          '- Cloudflare version ID: 未取得',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      );
    }
  } catch (error) {
    exitCode = 1;
    const code = error instanceof ProductionSamplePreflightFailure ? error.code : 'INTERNAL_ERROR';
    console.error(`production-sample-preflight: ${code}`);
  }
  process.exitCode = exitCode;
}

await main();
