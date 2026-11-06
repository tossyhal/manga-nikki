import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BootstrapFailure,
  STAGING_WORKER_SOURCE,
  STAGING_WRANGLER_CONFIG,
  type DeploymentPlan,
} from './deployment-bootstrap';
import { runWranglerBootstrap } from './deployment-bootstrap-runner';

const plan: DeploymentPlan = {
  workerSource: STAGING_WORKER_SOURCE,
  wranglerConfig: STAGING_WRANGLER_CONFIG,
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('Wrangler staging bootstrap runner', () => {
  it('固定Wrangler・一時config・cwdを使い、成功後に一時dirを削除する', async () => {
    let receivedFile = '';
    let receivedArgs: string[] = [];
    let receivedCwd = '';

    await runWranglerBootstrap(plan, {
      async executor(file, args, options) {
        receivedFile = file;
        receivedArgs = args;
        receivedCwd = options.cwd;

        expect(file).toBe(process.execPath);
        expect(args[0]).toContain(`${join('node_modules', 'wrangler', 'bin', 'wrangler.js')}`);
        expect(args[1]).toBe('deploy');
        expect(args).toEqual([
          args[0],
          'deploy',
          '--config',
          join(options.cwd, 'wrangler.jsonc'),
          '--no-bundle',
          '--no-autoconfig',
        ]);
        expect(args[0]).not.toContain(options.cwd);
        expect(options.cwd).not.toContain(process.cwd());
        expect(options.env.WRANGLER_SEND_METRICS).toBe('false');
        expect(options.timeout).toBe(120_000);

        const worker = await readFile(join(options.cwd, 'worker.mjs'), 'utf8');
        const configText = await readFile(join(options.cwd, 'wrangler.jsonc'), 'utf8');
        const config = JSON.parse(configText) as Record<string, unknown>;
        expect(worker).toBe(STAGING_WORKER_SOURCE);
        expect(configText).toBe(STAGING_WRANGLER_CONFIG);
        expect(config).toMatchObject({ workers_dev: false, preview_urls: false, routes: [] });
        expect(config).not.toHaveProperty('bindings');
        return { stdout: 'captured-output-sentinel', stderr: '' };
      },
    });

    expect(receivedFile).toBe(process.execPath);
    expect(receivedArgs).toContain('--config');
    expect(receivedCwd).not.toBe('');
    expect(await exists(receivedCwd)).toBe(false);
  });

  it('executor失敗を固定error codeへ変換し、secret本文を隠して一時dirを削除する', async () => {
    const errorSentinel = 'private-stderr-secret-sentinel';
    let receivedCwd = '';

    let thrown: unknown;
    try {
      await runWranglerBootstrap(plan, {
        async executor(_file, _args, options) {
          receivedCwd = options.cwd;
          throw new Error(errorSentinel);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BootstrapFailure);
    expect((thrown as BootstrapFailure).code).toBe('DEPLOY_FAILED');
    expect((thrown as Error).message).toBe('DEPLOY_FAILED');
    expect((thrown as Error).message).not.toContain(errorSentinel);
    expect(await exists(receivedCwd)).toBe(false);
  });
});
