import { appendFile } from 'node:fs/promises';
import { PRODUCTION_CONNECTED_PROFILE } from '../src/build/production-connected-deployment.ts';
import {
  checkProductionConnectedPreflight,
  ProductionConnectedPreflightFailure,
} from '../src/build/production-connected-preflight.ts';

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    const result = await checkProductionConnectedPreflight({
      githubActions: process.env.GITHUB_ACTIONS,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubSha: process.env.GITHUB_SHA,
      githubActorId: process.env.GITHUB_ACTOR_ID,
      githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
      githubToken: process.env.GITHUB_TOKEN,
      workerUrl: process.env.PRODUCTION_WORKER_URL,
      allowedOwnerId: process.env.PRODUCTION_GENERATION_ALLOWED_OWNER_ID,
      infrastructureEnabled: process.env.PRODUCTION_GENERATION_INFRA_ENABLED,
      generationEnabled: process.env.PRODUCTION_GENERATION_ENABLED,
      bwsOpenaiApiKeySecretId: process.env.BWS_OPENAI_API_KEY_SECRET_ID,
      productionConnectedCdEnabled: process.env.PRODUCTION_CONNECTED_CD_ENABLED,
      bwsCloudflareSecretId: process.env.BWS_CLOUDFLARE_SECRET_ID,
      bwsSupabasePublishableKeySecretId: process.env.BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID,
      bwsSupabaseSecretKeySecretId: process.env.BWS_SUPABASE_SECRET_KEY_SECRET_ID,
      bwsTurnstileSiteKeySecretId: process.env.BWS_TURNSTILE_SITE_KEY_SECRET_ID,
      bwsTurnstileSecretKeySecretId: process.env.BWS_TURNSTILE_SECRET_KEY_SECRET_ID,
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
          '## Production connected CD',
          '',
          '- Environment: `production`',
          `- Commit: \`${result.commit}\``,
          `- URL: ${PRODUCTION_CONNECTED_PROFILE.workerUrl}`,
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
    const code =
      error instanceof ProductionConnectedPreflightFailure ? error.code : 'INTERNAL_ERROR';
    console.error(`production-connected-preflight: ${code}`);
  }
  process.exitCode = exitCode;
}

await main();
