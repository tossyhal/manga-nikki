import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BootstrapFailure, type DeploymentPlan } from './deployment-bootstrap.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const wranglerCli = join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export type WranglerExecutionOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
};

export type WranglerExecutor = (
  file: string,
  args: string[],
  options: WranglerExecutionOptions,
) => Promise<unknown>;

export type WranglerBootstrapDependencies = {
  executor?: WranglerExecutor;
};

async function executeWrangler(
  file: string,
  args: string[],
  options: WranglerExecutionOptions,
): Promise<void> {
  await execFileAsync(file, args, options);
}

export async function runWranglerBootstrap(
  plan: DeploymentPlan,
  dependencies: WranglerBootstrapDependencies = {},
): Promise<void> {
  let temporaryDirectory: string | undefined;
  let failed = false;

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'manga-nikki-staging-bootstrap-'));
    const workerPath = join(temporaryDirectory, 'worker.mjs');
    const configPath = join(temporaryDirectory, 'wrangler.jsonc');
    await writeFile(workerPath, plan.workerSource, { encoding: 'utf8', mode: 0o600 });
    await writeFile(configPath, plan.wranglerConfig, { encoding: 'utf8', mode: 0o600 });
    await (dependencies.executor ?? executeWrangler)(
      process.execPath,
      [wranglerCli, 'deploy', '--config', configPath, '--no-bundle', '--no-autoconfig'],
      {
        cwd: temporaryDirectory,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    failed = true;
  } finally {
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new BootstrapFailure('DEPLOY_FAILED');
}
