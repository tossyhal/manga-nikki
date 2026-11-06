import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STAGING_SAMPLE_ACCOUNT_ID,
  STAGING_SAMPLE_WORKER_NAME,
  StagingSampleDeploymentFailure,
} from './staging-sample-deployment';
import {
  prepareStagingReleaseArtifact,
  runWranglerStagingSampleDeploy,
} from './staging-sample-deployment-runner';

const commit = 'c'.repeat(40);

function stagingConfig(overrides: Record<string, unknown> = {}) {
  return {
    configPath: '/repo/wrangler.jsonc',
    userConfigPath: '/repo/wrangler.jsonc',
    topLevelName: 'manga-nikki',
    definedEnvironments: ['local-connected', 'staging', 'production'],
    targetEnvironment: 'staging',
    name: STAGING_SAMPLE_WORKER_NAME,
    main: 'index.js',
    workers_dev: true,
    preview_urls: false,
    triggers: { crons: [] },
    assets: { directory: '../client', run_worker_first: ['/api/*'] },
    vars: {
      APP_ENV: 'staging',
      DATA_MODE: 'sample',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    },
    secrets: { required: [] },
    durable_objects: { bindings: [] },
    workflows: [],
    migrations: [],
    exports: {},
    kv_namespaces: [],
    queues: { producers: [], consumers: [] },
    r2_buckets: [],
    d1_databases: [],
    services: [],
    routes: [],
    observability: { enabled: false },
    ...overrides,
  };
}

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'manga-nikki-staging-artifact-'));
  await mkdir(join(projectRoot, '.wrangler', 'deploy'), { recursive: true });
  await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
  await mkdir(join(projectRoot, 'dist', 'manga_nikki'), { recursive: true });
  await writeFile(join(projectRoot, 'dist', 'client', 'index.html'), '<html></html>');
  await writeFile(
    join(projectRoot, 'dist', 'manga_nikki', 'wrangler.json'),
    JSON.stringify(stagingConfig(overrides)),
  );
  await writeFile(join(projectRoot, 'dist', 'manga_nikki', 'index.js'), 'export default {};');
  await writeFile(
    join(projectRoot, '.wrangler', 'deploy', 'config.json'),
    JSON.stringify({ configPath: '../../dist/manga_nikki/wrangler.json', auxiliaryWorkers: [] }),
  );
  return projectRoot;
}

async function withFixture(
  run: (projectRoot: string) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const projectRoot = await createFixture(overrides);
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function failureCode(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(StagingSampleDeploymentFailure);
    return (error as StagingSampleDeploymentFailure).code;
  }
  throw new Error('Expected artifact validation failure');
}

describe('staging sample release artifact', () => {
  it('uses the build-generated dist config and writes only the fictional deployment marker', async () => {
    await withFixture(async (projectRoot) => {
      const result = await prepareStagingReleaseArtifact(commit, projectRoot);
      expect(result.configPath).toBe(join(projectRoot, 'dist', 'manga_nikki', 'wrangler.json'));
      expect(
        JSON.parse(
          await readFile(join(projectRoot, 'dist', 'client', '__deployment.json'), 'utf8'),
        ),
      ).toEqual({
        environment: 'staging',
        commit,
        dataMode: 'sample',
      });
      expect(await readFile(result.configPath, 'utf8')).toContain(STAGING_SAMPLE_WORKER_NAME);
      expect(STAGING_SAMPLE_ACCOUNT_ID).toBe('c9cee9599752cb191815c0eea6ff457e');
    });
  });

  it('rejects live mode, cron, queue, server binding and custom route configuration', async () => {
    const unsafeConfigurations = [
      {
        vars: {
          APP_ENV: 'staging',
          DATA_MODE: 'live',
          AI_MODE: 'mock',
          GENERATION_ENABLED: 'false',
        },
      },
      { triggers: { crons: ['0 15 * * *'] } },
      { queues: { producers: [{ binding: 'GENERATION_QUEUE' }], consumers: [] } },
      { bindings: [{ type: 'secret_text', name: 'PRIVATE' }] },
      { route: 'example.com/*' },
      { workers_dev: false },
      { main: '../../outside.js' },
    ];

    for (const config of unsafeConfigurations) {
      await withFixture(async (projectRoot) => {
        expect(await failureCode(prepareStagingReleaseArtifact(commit, projectRoot))).toBe(
          'ARTIFACT_CONFIG_UNSAFE',
        );
      }, config);
    }
  });

  it('rejects missing, traversal and symlink-escaped config paths', async () => {
    await withFixture(async (projectRoot) => {
      await writeFile(
        join(projectRoot, '.wrangler', 'deploy', 'config.json'),
        JSON.stringify({ configPath: '../../../../etc/passwd' }),
      );
      expect(await failureCode(prepareStagingReleaseArtifact(commit, projectRoot))).toBe(
        'ARTIFACT_CONFIG_PATH_INVALID',
      );
    });

    await withFixture(async (projectRoot) => {
      const outside = join(projectRoot, 'outside.json');
      await writeFile(outside, JSON.stringify(stagingConfig()));
      await rm(join(projectRoot, 'dist', 'manga_nikki', 'wrangler.json'));
      await symlink(outside, join(projectRoot, 'dist', 'manga_nikki', 'wrangler.json'));
      expect(await failureCode(prepareStagingReleaseArtifact(commit, projectRoot))).toBe(
        'ARTIFACT_CONFIG_PATH_INVALID',
      );
    });
  });

  it('rejects .dev.vars and any symbolic link inside dist before deployment', async () => {
    await withFixture(async (projectRoot) => {
      await writeFile(join(projectRoot, 'dist', 'client', '.dev.vars'), 'PRIVATE=secret');
      expect(await failureCode(prepareStagingReleaseArtifact(commit, projectRoot))).toBe(
        'ARTIFACT_CONFIG_UNSAFE',
      );
    });

    await withFixture(async (projectRoot) => {
      await symlink(
        join(projectRoot, 'outside.json'),
        join(projectRoot, 'dist', 'client', 'linked.json'),
      );
      expect(await failureCode(prepareStagingReleaseArtifact(commit, projectRoot))).toBe(
        'ARTIFACT_CONFIG_UNSAFE',
      );
    });
  });

  it('runs only the fixed local Wrangler with the validated config and fixed account env', async () => {
    let receivedArgs: string[] = [];
    let receivedOptions: { cwd: string; env: NodeJS.ProcessEnv; timeout: number } | undefined;
    const envKeys = [
      'PATH',
      'HOME',
      'TMPDIR',
      'CI',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'BWS_ACCESS_TOKEN',
      'MISE_GITHUB_TOKEN',
      'UNRELATED_SECRET',
      'CLOUDFLARE_API_TOKEN',
    ] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      PATH: '/sentinel/path',
      HOME: '/sentinel/home',
      TMPDIR: '/sentinel/tmp',
      CI: 'true',
      GITHUB_TOKEN: 'github-token-child-sentinel',
      GH_TOKEN: 'gh-token-child-sentinel',
      BWS_ACCESS_TOKEN: 'bws-token-child-sentinel',
      MISE_GITHUB_TOKEN: 'mise-github-token-child-sentinel',
      UNRELATED_SECRET: 'unrelated-secret-child-sentinel',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token-child-sentinel',
    });
    try {
      await runWranglerStagingSampleDeploy('/repo/dist/manga_nikki/wrangler.json', {
        async executor(file, args, options) {
          expect(file).toBe(process.execPath);
          receivedArgs = args;
          receivedOptions = options;
          return { stdout: 'private stdout sentinel', stderr: 'private stderr sentinel' };
        },
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(receivedArgs[0]).toContain(join('node_modules', 'wrangler', 'bin', 'wrangler.js'));
    expect(receivedArgs.slice(1)).toEqual([
      'deploy',
      '--config',
      '/repo/dist/manga_nikki/wrangler.json',
    ]);
    expect(receivedArgs).not.toContain('--env');
    expect(receivedOptions?.env.CLOUDFLARE_ACCOUNT_ID).toBe(STAGING_SAMPLE_ACCOUNT_ID);
    expect(receivedOptions?.env.WRANGLER_SEND_METRICS).toBe('false');
    expect(receivedOptions?.env.CLOUDFLARE_API_TOKEN).toBe('cloudflare-token-child-sentinel');
    expect(receivedOptions?.env.PATH).toBe('/sentinel/path');
    expect(receivedOptions?.env.HOME).toBe('/sentinel/home');
    expect(receivedOptions?.env.TMPDIR).toBe('/sentinel/tmp');
    expect(receivedOptions?.env.CI).toBe('true');
    expect(receivedOptions?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(receivedOptions?.env).not.toHaveProperty('GH_TOKEN');
    expect(receivedOptions?.env).not.toHaveProperty('BWS_ACCESS_TOKEN');
    expect(receivedOptions?.env).not.toHaveProperty('MISE_GITHUB_TOKEN');
    expect(receivedOptions?.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(receivedOptions?.env ?? {}).sort()).toEqual(
      [
        'CI',
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_API_TOKEN',
        'HOME',
        'PATH',
        'TMPDIR',
        'WRANGLER_SEND_METRICS',
      ].sort(),
    );
    expect(receivedOptions?.timeout).toBe(120_000);
  });

  it('hides Wrangler output and rejects runner errors with a fixed code', async () => {
    const sentinel = 'private-wrangler-stderr-secret';
    const error = await failureCode(
      runWranglerStagingSampleDeploy('/repo/dist/manga_nikki/wrangler.json', {
        async executor() {
          throw new Error(sentinel);
        },
      }),
    );

    expect(error).toBe('WRANGLER_DEPLOY_FAILED');
    expect(error).not.toContain(sentinel);
  });
});
