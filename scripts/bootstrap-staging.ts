import { appendFile } from 'node:fs/promises';
import {
  BootstrapFailure,
  renderBootstrapSummary,
  runDeploymentBootstrap,
  type BootstrapDisplayErrorCode,
  type BootstrapOperation,
  type BootstrapProgress,
} from '../src/build/deployment-bootstrap.ts';
import { runWranglerBootstrap } from '../src/build/deployment-bootstrap-runner.ts';

function safeOperation(value: string | undefined): BootstrapOperation | 'unknown' {
  if (value === undefined || value === '') return 'check';
  return value === 'check' || value === 'create' ? value : 'unknown';
}

async function main(): Promise<void> {
  const progress: BootstrapProgress = {
    operation: safeOperation(process.env.DEPLOYMENT_OPERATION),
    existence: 'unknown',
    creation: 'not-requested',
    publicUrlCheck: 'not-run',
  };
  let errorCode: BootstrapDisplayErrorCode | undefined;
  let exitCode = 0;

  try {
    await runDeploymentBootstrap(
      {
        githubActions: process.env.GITHUB_ACTIONS,
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubRef: process.env.GITHUB_REF,
        operation: process.env.DEPLOYMENT_OPERATION,
        confirmation: process.env.DEPLOYMENT_CONFIRMATION,
        exclusiveSetup: process.env.DEPLOYMENT_EXCLUSIVE_SETUP,
        cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      },
      {
        deploy: runWranglerBootstrap,
        onProgress(nextProgress) {
          Object.assign(progress, nextProgress);
        },
      },
    );
  } catch (error) {
    errorCode = error instanceof BootstrapFailure ? error.code : 'INTERNAL_ERROR';
    exitCode = 1;
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  let summaryWriteFailed = false;
  if (summaryPath) {
    try {
      const summary = renderBootstrapSummary(progress, process.env.GITHUB_SHA, errorCode);
      await appendFile(summaryPath, summary, { encoding: 'utf8', mode: 0o600 });
    } catch {
      summaryWriteFailed = true;
      exitCode = 1;
    }
  }

  if (errorCode) console.error(`deployment-bootstrap: ${errorCode}`);
  if (summaryWriteFailed) console.error('deployment-bootstrap: SUMMARY_WRITE_FAILED');
  process.exitCode = exitCode;
}

await main();
