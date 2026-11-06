import { chmod, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  renderSampleDeploymentSummary,
  runSampleDeployment,
  SAMPLE_DEPLOYMENT_ACCOUNT_ID,
  SampleDeploymentFailure,
  type SampleDeploymentDisplayErrorCode,
  type SampleDeploymentContext,
  type SampleDeploymentDependencies,
  type SampleDeploymentProgress,
} from './sample-deployment.ts';
import {
  prepareSampleReleaseArtifact,
  type WranglerExecutionOptions,
  type WranglerExecutor,
} from './sample-deployment-runner.ts';
import {
  PRODUCTION_CONNECTED_PROFILE,
  validateProductionWorkerSecrets,
  validateProductionReleasePublicValues,
  type ProductionReleasePublicValues,
  type ProductionWorkerSecrets,
} from './production-connected-deployment.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const wranglerCli = join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export type WranglerProductionConnectedDependencies = {
  executor?: WranglerExecutor;
  temporaryRoot?: string;
};

export type ProductionConnectedDeploymentContext = Omit<
  SampleDeploymentContext,
  'workerPublicVars' | 'releasePublicValues'
> & {
  releasePublicValues: ProductionReleasePublicValues;
};

export type ProductionConnectedDeploymentDependencies = SampleDeploymentDependencies<'production'>;
export type ProductionConnectedDeploymentProgress = SampleDeploymentProgress<'production'>;

export function runProductionConnectedDeployment(
  context: ProductionConnectedDeploymentContext,
  dependencies: ProductionConnectedDeploymentDependencies = {},
) {
  const { workerPublicVars } = validateProductionReleasePublicValues(context.releasePublicValues);
  return runSampleDeployment(
    PRODUCTION_CONNECTED_PROFILE,
    {
      ...context,
      workerPublicVars,
      releasePublicValues: context.releasePublicValues as Readonly<Record<string, string>>,
    },
    dependencies,
  );
}

export function renderProductionConnectedDeploymentSummary(
  progress: ProductionConnectedDeploymentProgress,
  errorCode: SampleDeploymentDisplayErrorCode | undefined,
): string {
  return renderSampleDeploymentSummary(PRODUCTION_CONNECTED_PROFILE, progress, errorCode);
}

async function executeWrangler(
  file: string,
  args: string[],
  options: WranglerExecutionOptions,
): Promise<unknown> {
  return execFileAsync(file, args, options);
}

export async function prepareProductionConnectedReleaseArtifact(
  commit: string,
  workerPublicVars: Readonly<Record<string, string>>,
  releasePublicValues: ProductionReleasePublicValues,
  projectRoot?: string,
): Promise<{ configPath: string }> {
  return prepareSampleReleaseArtifact(
    PRODUCTION_CONNECTED_PROFILE,
    commit,
    projectRoot,
    workerPublicVars,
    releasePublicValues as Readonly<Record<string, string>>,
  );
}

export async function withProductionWorkerSecretsFile<T>(
  values: Partial<ProductionWorkerSecrets>,
  operation: (secretsFile: string) => Promise<T>,
  temporaryRoot = tmpdir(),
): Promise<T> {
  const secrets = validateProductionWorkerSecrets(values);
  let directory: string | undefined;
  let filePath: string | undefined;
  let cleanupFailed = false;
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;

  try {
    directory = await mkdtemp(join(temporaryRoot, 'manga-nikki-production-secrets-'));
    await chmod(directory, 0o700);
    filePath = join(directory, 'worker-secrets.json');
    const handle = await open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(secrets)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    result = await operation(filePath);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    if (filePath) {
      try {
        await unlink(filePath);
      } catch {
        cleanupFailed = true;
      }
    }
    if (directory) {
      try {
        await rmdir(directory);
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (cleanupFailed) throw new SampleDeploymentFailure('WRANGLER_DEPLOY_FAILED');
  if (operationFailed) throw operationError;
  return result as T;
}

export async function runWranglerProductionConnectedDeploy(
  configPath: string,
  cloudflareApiToken: string | undefined,
  secrets: Partial<ProductionWorkerSecrets>,
  dependencies: WranglerProductionConnectedDependencies = {},
): Promise<void> {
  if (
    !cloudflareApiToken ||
    cloudflareApiToken.trim() !== cloudflareApiToken ||
    /[\r\n]/.test(cloudflareApiToken)
  ) {
    throw new SampleDeploymentFailure('INPUT_CLOUDFLARE_TOKEN_INVALID');
  }

  await withProductionWorkerSecretsFile(
    secrets,
    async (secretsFile) => {
      const env: NodeJS.ProcessEnv = {};
      for (const name of ['PATH', 'HOME', 'TMPDIR', 'CI'] as const) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
      env.CLOUDFLARE_ACCOUNT_ID = SAMPLE_DEPLOYMENT_ACCOUNT_ID;
      env.WRANGLER_SEND_METRICS = 'false';

      try {
        await (dependencies.executor ?? executeWrangler)(
          process.execPath,
          [wranglerCli, 'deploy', '--config', configPath, '--secrets-file', secretsFile],
          {
            cwd: repositoryRoot,
            env,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        );
      } catch {
        throw new SampleDeploymentFailure('WRANGLER_DEPLOY_FAILED');
      }
    },
    dependencies.temporaryRoot,
  );
}
