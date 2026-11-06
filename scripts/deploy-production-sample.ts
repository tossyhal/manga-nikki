import { appendFile } from 'node:fs/promises';
import {
  renderProductionSampleDeploymentSummary,
  runProductionSampleDeployment,
  ProductionSampleDeploymentFailure,
  PRODUCTION_SAMPLE_WORKER_URL,
  type ProductionSampleDeploymentDisplayErrorCode,
  type ProductionSampleDeploymentProgress,
} from '../src/build/production-sample-deployment.ts';
import {
  prepareProductionReleaseArtifact,
  runWranglerProductionSampleDeploy,
} from '../src/build/production-sample-deployment-runner.ts';

async function main(): Promise<void> {
  const initialCommit = process.env.GITHUB_SHA ?? '';
  const progress: ProductionSampleDeploymentProgress = {
    environment: 'production',
    commit: /^[0-9a-f]{40}$/i.test(initialCommit) ? initialCommit.toLowerCase() : 'unknown',
    url:
      process.env.PRODUCTION_WORKER_URL === PRODUCTION_SAMPLE_WORKER_URL
        ? PRODUCTION_SAMPLE_WORKER_URL
        : '未設定',
    deployment: 'not-run',
    smoke: 'not-run',
  };
  let errorCode: ProductionSampleDeploymentDisplayErrorCode | undefined;
  let exitCode = 0;

  try {
    await runProductionSampleDeployment(
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
      },
      {
        prepareArtifact: (commit) => prepareProductionReleaseArtifact(commit),
        deploy: (configPath) => runWranglerProductionSampleDeploy(configPath),
        onProgress(nextProgress) {
          Object.assign(progress, nextProgress);
        },
      },
    );
  } catch (error) {
    errorCode = error instanceof ProductionSampleDeploymentFailure ? error.code : 'INTERNAL_ERROR';
    exitCode = 1;
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  let summaryWriteFailed = false;
  if (summaryPath) {
    try {
      await appendFile(summaryPath, renderProductionSampleDeploymentSummary(progress, errorCode), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      summaryWriteFailed = true;
      exitCode = 1;
    }
  }

  if (errorCode) console.error(`production-sample-deployment: ${errorCode}`);
  if (summaryWriteFailed) console.error('production-sample-deployment: SUMMARY_WRITE_FAILED');
  process.exitCode = exitCode;
}

await main();
