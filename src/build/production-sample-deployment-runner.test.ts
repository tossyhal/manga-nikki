import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRODUCTION_SAMPLE_ACCOUNT_ID,
  PRODUCTION_SAMPLE_WORKER_NAME,
} from './production-sample-deployment';
import {
  prepareProductionReleaseArtifact,
  ProductionSampleDeploymentFailure,
  runWranglerProductionSampleDeploy,
} from './production-sample-deployment-runner';
import type { WranglerExecutionOptions } from './production-sample-deployment-runner';

const temporaryDirectories: string[] = [];

async function createArtifact(configOverrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-artifact-'));
  temporaryDirectories.push(root);
  const deployDirectory = path.join(root, '.wrangler/deploy');
  const outputDirectory = path.join(root, 'dist/manga_nikki');
  const clientDirectory = path.join(root, 'dist/client');
  const serverDirectory = path.join(root, 'dist/server');
  await mkdir(deployDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(clientDirectory, { recursive: true });
  await mkdir(serverDirectory, { recursive: true });
  await writeFile(path.join(serverDirectory, 'index.js'), 'export {};\n');
  await writeFile(
    path.join(deployDirectory, 'config.json'),
    JSON.stringify({ configPath: '../../dist/manga_nikki/wrangler.json' }),
  );
  const config = {
    name: 'manga-nikki',
    targetEnvironment: 'production',
    workers_dev: true,
    preview_urls: false,
    account_id: PRODUCTION_SAMPLE_ACCOUNT_ID,
    main: '../server/index.js',
    vars: {
      APP_ENV: 'production',
      DATA_MODE: 'sample',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    },
    triggers: { crons: [] },
    assets: { directory: '../client' },
    routes: [],
    observability: { enabled: false },
    ...configOverrides,
  };
  const configPath = path.join(outputDirectory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  return { root, configPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('production sample deployment runner', () => {
  it('accepts only the fixed production config and adds a production SHA marker', async () => {
    const { root } = await createArtifact();
    const result = await prepareProductionReleaseArtifact('a'.repeat(40), root);
    const config = JSON.parse(await readFile(result.configPath, 'utf8'));
    const marker = JSON.parse(
      await readFile(path.join(root, 'dist/client/__deployment.json'), 'utf8'),
    );

    expect(config.name).toBe(PRODUCTION_SAMPLE_WORKER_NAME);
    expect(config.targetEnvironment).toBe('production');
    expect(config.account_id).toBe(PRODUCTION_SAMPLE_ACCOUNT_ID);
    expect(config.vars).toEqual({
      APP_ENV: 'production',
      DATA_MODE: 'sample',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    });
    expect(config.triggers.crons).toEqual([]);
    expect(config.queues).toBeUndefined();
    expect(marker).toEqual({
      environment: 'production',
      commit: 'a'.repeat(40),
      dataMode: 'sample',
    });
  });

  it('rejects an artifact targeted at staging or another account before deploy', async () => {
    const wrongName = await createArtifact({ name: 'manga-nikki-staging' });
    await expect(
      prepareProductionReleaseArtifact('a'.repeat(40), wrongName.root),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_CONFIG_UNSAFE',
    });

    const wrongAccount = await createArtifact({ account_id: 'foreign-account' });
    await expect(
      prepareProductionReleaseArtifact('a'.repeat(40), wrongAccount.root),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_CONFIG_UNSAFE',
    });
  });

  it('runs Wrangler with only the fixed production account and suppresses child output', async () => {
    const observed: {
      file?: string;
      args?: string[];
      options?: WranglerExecutionOptions;
    } = {};
    await runWranglerProductionSampleDeploy('/tmp/dist/manga_nikki/wrangler.json', {
      async executor(file, args, options) {
        observed.file = file;
        observed.args = args;
        observed.options = options;
        return { stdout: 'should-not-be-logged', stderr: 'secret-output' };
      },
    });

    expect(observed.args).toEqual([
      expect.stringContaining('/node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--config',
      '/tmp/dist/manga_nikki/wrangler.json',
    ]);
    expect(observed.options?.env.CLOUDFLARE_ACCOUNT_ID).toBe(PRODUCTION_SAMPLE_ACCOUNT_ID);
    expect(observed.options?.env.WRANGLER_SEND_METRICS).toBe('false');
    expect(observed.options?.env.SUPABASE_SECRET_KEY).toBeUndefined();
    expect(observed.options?.env.OPENAI_API_KEY).toBeUndefined();
    expect(observed.options?.timeout).toBe(120_000);
  });

  it('does not expose Wrangler errors or output content', async () => {
    try {
      await runWranglerProductionSampleDeploy('/unused', {
        async executor() {
          throw new Error('secret-output');
        },
      });
      throw new Error('Expected deploy to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionSampleDeploymentFailure);
      expect((error as Error).message).toBe('WRANGLER_DEPLOY_FAILED');
      expect((error as Error).message).not.toContain('secret-output');
    }
  });
});
