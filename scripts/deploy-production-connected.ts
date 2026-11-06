import { appendFile } from 'node:fs/promises';
import {
  PRODUCTION_CONNECTED_PROFILE,
  ProductionConnectedDeploymentFailure,
  validateProductionWorkerSecrets,
  type ProductionReleasePublicValues,
} from '../src/build/production-connected-deployment.ts';
import {
  prepareProductionConnectedReleaseArtifact,
  renderProductionConnectedDeploymentSummary,
  runProductionConnectedDeployment,
  runWranglerProductionConnectedDeploy,
  type ProductionConnectedDeploymentProgress,
} from '../src/build/production-connected-deployment-runner.ts';
import { runProductionSupabaseConnectionProbe } from '../src/build/production-supabase-probe.ts';
import { PRODUCTION_SUPABASE_URL } from '../src/build/public-config-guard.ts';
import {
  SampleDeploymentFailure,
  type SampleDeploymentDisplayErrorCode,
} from '../src/build/sample-deployment.ts';

async function main(): Promise<void> {
  const initialCommit = process.env.GITHUB_SHA ?? '';
  const progress: ProductionConnectedDeploymentProgress = {
    environment: 'production',
    commit: /^[0-9a-f]{40}$/i.test(initialCommit) ? initialCommit.toLowerCase() : 'unknown',
    url: PRODUCTION_CONNECTED_PROFILE.workerUrl,
    deployment: 'not-run',
    smoke: 'not-run',
  };
  const releasePublicValues: ProductionReleasePublicValues = {
    VITE_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY,
  };
  let errorCode: SampleDeploymentDisplayErrorCode | undefined;
  let exitCode = 0;

  try {
    const workerSecrets = validateProductionWorkerSecrets({
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    });
    await runProductionConnectedDeployment(
      {
        githubActions: process.env.GITHUB_ACTIONS,
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubRef: process.env.GITHUB_REF,
        githubEventName: process.env.GITHUB_EVENT_NAME,
        githubSha: process.env.GITHUB_SHA,
        githubActorId: process.env.GITHUB_ACTOR_ID,
        githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
        githubToken: process.env.GITHUB_TOKEN,
        cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
        workerUrl: process.env.PRODUCTION_WORKER_URL,
        releasePublicValues,
      },
      {
        prepareArtifact: (commit, workerPublicVars, publicValues) =>
          prepareProductionConnectedReleaseArtifact(
            commit,
            workerPublicVars ?? {},
            (publicValues ?? {}) as ProductionReleasePublicValues,
          ),
        beforeDeploy: () =>
          runProductionSupabaseConnectionProbe({
            supabaseUrl: 'https://leihsygtsamxffyybskh.supabase.co',
            publishableKey: releasePublicValues.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
            secretKey: workerSecrets.SUPABASE_SECRET_KEY,
          }),
        deploy: (configPath) =>
          runWranglerProductionConnectedDeploy(
            configPath,
            process.env.CLOUDFLARE_API_TOKEN,
            workerSecrets,
          ),
        onProgress(nextProgress) {
          Object.assign(progress, nextProgress);
        },
      },
    );
  } catch (error) {
    errorCode =
      error instanceof ProductionConnectedDeploymentFailure ||
      error instanceof SampleDeploymentFailure
        ? error.code
        : 'INTERNAL_ERROR';
    exitCode = 1;
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        renderProductionConnectedDeploymentSummary(progress, errorCode),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      errorCode = 'SUMMARY_WRITE_FAILED';
      exitCode = 1;
    }
  }

  if (errorCode) console.error(`production-connected-deployment: ${errorCode}`);
  process.exitCode = exitCode;
}

await main();
