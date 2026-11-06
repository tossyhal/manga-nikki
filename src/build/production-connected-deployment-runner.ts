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
  selectProductionConnectedProfile,
  validateProductionWorkerSecrets,
  validateProductionReleasePublicValues,
  type ProductionReleasePublicValues,
  type ProductionWorkerSecrets,
} from './production-connected-deployment.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const wranglerCli = join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PRODUCTION_SHARED_SMOKE_TOKEN = '0'.repeat(64);
const MAX_SHARED_SMOKE_RESPONSE_BYTES = 16 * 1024;

export type WranglerProductionConnectedDependencies = {
  executor?: WranglerExecutor;
  temporaryRoot?: string;
};

export type ProductionConnectedDeploymentContext = Omit<
  SampleDeploymentContext,
  'workerPublicVars' | 'releasePublicValues'
> & {
  releasePublicValues: ProductionReleasePublicValues;
  infrastructureEnabled?: string;
  generationEnabled?: string;
};

export type ProductionConnectedDeploymentDependencies = SampleDeploymentDependencies<'production'>;
export type ProductionConnectedDeploymentProgress = SampleDeploymentProgress<'production'>;

export async function runProductionConnectedDeployment(
  context: ProductionConnectedDeploymentContext,
  dependencies: ProductionConnectedDeploymentDependencies = {},
) {
  const { workerPublicVars } = validateProductionReleasePublicValues(context.releasePublicValues);
  const result = await runSampleDeployment(
    selectProductionConnectedProfile(context.infrastructureEnabled, context.generationEnabled),
    {
      ...context,
      workerPublicVars,
      releasePublicValues: context.releasePublicValues as Readonly<Record<string, string>>,
    },
    dependencies,
  );
  if (result.deployment !== 'succeeded' || result.smoke !== 'passed') return result;

  try {
    await verifyProductionSharedSmoke(dependencies.publicFetcher ?? fetch, result.url);
  } catch (error) {
    dependencies.onProgress?.({ ...result, smoke: 'failed' });
    throw error;
  }

  return result;
}

async function verifyProductionSharedSmoke(
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  workerUrl: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(
      new URL(`/api/v1/shared/${PRODUCTION_SHARED_SMOKE_TOKEN}`, workerUrl).toString(),
      {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new SampleDeploymentFailure('SMOKE_REQUEST_FAILED');
  }

  if (response.status !== 404) throw new SampleDeploymentFailure('SMOKE_RESPONSE_INVALID');

  let body: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing response body');
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SHARED_SMOKE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SampleDeploymentFailure('SMOKE_RESPONSE_INVALID');
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    typeof body.error !== 'object' ||
    body.error === null ||
    !('code' in body.error) ||
    body.error.code !== 'NOT_FOUND'
  ) {
    throw new SampleDeploymentFailure('SMOKE_RESPONSE_INVALID');
  }
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
  profile = PRODUCTION_CONNECTED_PROFILE,
): Promise<{ configPath: string }> {
  return prepareSampleReleaseArtifact(
    profile,
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
  profile = PRODUCTION_CONNECTED_PROFILE,
): Promise<T> {
  const secrets = validateProductionWorkerSecrets(values, profile);
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
  profile = PRODUCTION_CONNECTED_PROFILE,
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
    profile,
  );
}
