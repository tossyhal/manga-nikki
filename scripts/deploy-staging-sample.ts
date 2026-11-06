import { appendFile } from 'node:fs/promises';
import {
  renderStagingSampleDeploymentSummary,
  runStagingSampleDeployment,
  StagingSampleDeploymentFailure,
  STAGING_SAMPLE_WORKER_URL,
  type StagingSampleDeploymentDisplayErrorCode,
  type StagingSampleDeploymentProgress,
} from '../src/build/staging-sample-deployment.ts';
import {
  prepareStagingReleaseArtifact,
  runWranglerStagingSampleDeploy,
} from '../src/build/staging-sample-deployment-runner.ts';

async function main(): Promise<void> {
  const initialCommit = process.env.GITHUB_SHA ?? '';
  const progress: StagingSampleDeploymentProgress = {
    environment: 'staging',
    commit: /^[0-9a-f]{40}$/i.test(initialCommit) ? initialCommit.toLowerCase() : 'unknown',
    url:
      process.env.STAGING_WORKER_URL === STAGING_SAMPLE_WORKER_URL
        ? STAGING_SAMPLE_WORKER_URL
        : '未設定',
    deployment: 'not-run',
    smoke: 'not-run',
  };
  let errorCode: StagingSampleDeploymentDisplayErrorCode | undefined;
  let exitCode = 0;

  try {
    await runStagingSampleDeployment(
      {
        githubActions: process.env.GITHUB_ACTIONS,
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubRef: process.env.GITHUB_REF,
        githubEventName: process.env.GITHUB_EVENT_NAME,
        githubSha: process.env.GITHUB_SHA,
        githubToken: process.env.GITHUB_TOKEN,
        cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
        workerUrl: process.env.STAGING_WORKER_URL,
      },
      {
        prepareArtifact: (commit) => prepareStagingReleaseArtifact(commit),
        deploy: (configPath) => runWranglerStagingSampleDeploy(configPath),
        onProgress(nextProgress) {
          Object.assign(progress, nextProgress);
        },
      },
    );
  } catch (error) {
    errorCode = error instanceof StagingSampleDeploymentFailure ? error.code : 'INTERNAL_ERROR';
    exitCode = 1;
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  let summaryWriteFailed = false;
  if (summaryPath) {
    try {
      await appendFile(summaryPath, renderStagingSampleDeploymentSummary(progress, errorCode), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      summaryWriteFailed = true;
      exitCode = 1;
    }
  }

  if (errorCode) console.error(`staging-sample-deployment: ${errorCode}`);
  if (summaryWriteFailed) console.error('staging-sample-deployment: SUMMARY_WRITE_FAILED');
  process.exitCode = exitCode;
}

await main();
