import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  selectProductionConnectedProfile,
  productionGenerationQueueConfiguration,
  ProductionConnectedDeploymentFailure,
  PRODUCTION_PUBLIC_ENV_FILE,
  validateProductionReleasePublicValues,
  validateProductionWorkerSecrets,
  writeProductionPublicEnvironmentFile,
} from './production-connected-deployment';
import {
  prepareProductionConnectedReleaseArtifact,
  runWranglerProductionConnectedDeploy,
} from './production-connected-deployment-runner';
import type { WranglerExecutionOptions } from './sample-deployment-runner';

const commit = 'a'.repeat(40);
const publicValues = {
  VITE_SUPABASE_URL: 'https://leihsygtsamxffyybskh.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_release-sentinel',
  VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAAprod-site-123456',
};
const workerPublicVars = {
  SUPABASE_URL: publicValues.VITE_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: publicValues.VITE_SUPABASE_PUBLISHABLE_KEY,
  TURNSTILE_ALLOWED_HOSTNAMES: 'manga-nikki.tossyhal.workers.dev',
};
const privateValues = {
  SUPABASE_SECRET_KEY: 'sb_secret_worker-sentinel',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAturnstile-secret-sentinel',
};
const temporaryDirectories: string[] = [];

function jwtWithRole(role: string): string {
  return `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
}

async function createArtifact(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-connected-artifact-'));
  temporaryDirectories.push(root);
  const deployDirectory = path.join(root, '.wrangler/deploy');
  const outputDirectory = path.join(root, 'dist/server');
  const clientDirectory = path.join(root, 'dist/client');
  await mkdir(deployDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(clientDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'index.js'), 'export {}\n');
  await writeFile(path.join(clientDirectory, 'index.js'), Object.values(publicValues).join('\n'));
  await writeFile(
    path.join(deployDirectory, 'config.json'),
    JSON.stringify({ configPath: '../../dist/server/wrangler.json' }),
  );
  const config = {
    name: 'manga-nikki',
    targetEnvironment: 'production',
    workers_dev: true,
    preview_urls: false,
    main: 'index.js',
    vars: {
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      ...workerPublicVars,
    },
    triggers: { crons: ['0 15 * * *'] },
    secrets: { required: ['SUPABASE_SECRET_KEY', 'TURNSTILE_SECRET_KEY'] },
    assets: { directory: '../client' },
    routes: [],
    observability: { enabled: false },
    ...overrides,
  };
  await writeFile(path.join(outputDirectory, 'wrangler.json'), JSON.stringify(config));
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('production connected public configuration', () => {
  it('accepts fixed URL and publishable production values, and maps only public Worker vars', () => {
    expect(validateProductionReleasePublicValues(publicValues).workerPublicVars).toEqual(
      workerPublicVars,
    );
  });

  it.each([
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: undefined },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [{ ...publicValues, VITE_SUPABASE_URL: 'https://other.example.invalid' }, 'VITE_SUPABASE_URL'],
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: 'opaque-unknown-key' },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: 'service_role_unknown' },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private-sentinel' },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: 'sk-proj-private-sentinel' },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [
      {
        ...publicValues,
        VITE_SUPABASE_PUBLISHABLE_KEY: jwtWithRole('service_role'),
      },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
    [
      { ...publicValues, VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
      'VITE_TURNSTILE_SITE_KEY',
    ],
    [{ ...publicValues, VITE_TURNSTILE_SITE_KEY: 'site-key\nsentinel' }, 'VITE_TURNSTILE_SITE_KEY'],
    [
      { ...publicValues, VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAAsite-key-length-is-too-long' },
      'VITE_TURNSTILE_SITE_KEY',
    ],
    [
      { ...publicValues, VITE_SUPABASE_PUBLISHABLE_KEY: ' sb_publishable_padded' },
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ],
  ])(
    'rejects incomplete or unsafe browser values without exposing them',
    (values, expectedSetting) => {
      let error: unknown;
      try {
        validateProductionReleasePublicValues(values as typeof publicValues);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ProductionConnectedDeploymentFailure);
      expect((error as Error).message).toBe('INPUT_PUBLIC_CONFIGURATION_INVALID');
      expect((error as Error).message).not.toContain('private-sentinel');
      expect((error as ProductionConnectedDeploymentFailure).publicSetting).toBe(expectedSetting);
    },
  );

  it('writes only the allowlisted production VITE values into a new mode-0600 file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-env-'));
    temporaryDirectories.push(root);
    const filePath = await writeProductionPublicEnvironmentFile(root, publicValues);
    const details = await stat(filePath);
    const contents = await readFile(filePath, 'utf8');
    expect(path.basename(filePath)).toBe(PRODUCTION_PUBLIC_ENV_FILE);
    expect(details.mode & 0o777).toBe(0o600);
    expect(contents).toContain(
      `VITE_SUPABASE_PUBLISHABLE_KEY="${publicValues.VITE_SUPABASE_PUBLISHABLE_KEY}"`,
    );
    expect(contents.match(/^VITE_/gm)).toHaveLength(3);
    await expect(writeProductionPublicEnvironmentFile(root, publicValues)).rejects.toMatchObject({
      code: 'INPUT_PUBLIC_CONFIGURATION_INVALID',
    });
  });

  it('ignores unrelated input properties and does not write server values to the browser file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-env-allowlist-'));
    temporaryDirectories.push(root);
    const filePath = await writeProductionPublicEnvironmentFile(root, {
      ...publicValues,
      OPENAI_API_KEY: 'sk-proj-private-sentinel',
    } as typeof publicValues);
    const contents = await readFile(filePath, 'utf8');
    expect(contents.match(/^VITE_/gm)).toHaveLength(3);
    expect(contents).not.toContain('OPENAI_API_KEY');
    expect(contents).not.toContain('private-sentinel');
  });

  it('rejects an existing symlink without following or replacing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-env-link-'));
    temporaryDirectories.push(root);
    const target = path.join(root, 'target');
    const link = path.join(root, PRODUCTION_PUBLIC_ENV_FILE);
    await writeFile(target, 'keep-me');
    await symlink(target, link);
    await expect(writeProductionPublicEnvironmentFile(root, publicValues)).rejects.toMatchObject({
      code: 'INPUT_PUBLIC_CONFIGURATION_INVALID',
    });
    expect(await readFile(target, 'utf8')).toBe('keep-me');
  });

  it('accepts only new server keys or legacy service_role JWTs', () => {
    const legacyServiceRole = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
    expect(
      validateProductionWorkerSecrets({ ...privateValues, SUPABASE_SECRET_KEY: legacyServiceRole })
        .SUPABASE_SECRET_KEY,
    ).toBe(legacyServiceRole);
    expect(() =>
      validateProductionWorkerSecrets({
        ...privateValues,
        SUPABASE_SECRET_KEY: jwtWithRole('anon'),
      }),
    ).toThrow('INPUT_PRIVATE_SECRET_INVALID');
    expect(() =>
      validateProductionWorkerSecrets({
        ...privateValues,
        TURNSTILE_SECRET_KEY: '3x0000000000000000000000000000000AA',
      }),
    ).toThrow('INPUT_PRIVATE_SECRET_INVALID');
  });
});

describe('production connected release artifact', () => {
  it('requires live modes, generation off, exact public vars, two secrets and cleanup Cron', async () => {
    const root = await createArtifact();
    const result = await prepareProductionConnectedReleaseArtifact(
      commit,
      workerPublicVars,
      publicValues,
      root,
    );
    const config = JSON.parse(await readFile(result.configPath, 'utf8'));
    const marker = JSON.parse(
      await readFile(path.join(root, 'dist/client/__deployment.json'), 'utf8'),
    );
    expect(config.vars).toEqual({
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      ...workerPublicVars,
    });
    expect(config.triggers.crons).toEqual(['0 15 * * *']);
    expect(config.secrets.required).toEqual(['SUPABASE_SECRET_KEY', 'TURNSTILE_SECRET_KEY']);
    expect(config.queues).toBeUndefined();
    expect(marker).toEqual({ environment: 'production', commit, dataMode: 'live' });
  });

  it.each([
    [
      {
        vars: {
          APP_ENV: 'production',
          DATA_MODE: 'live',
          AI_MODE: 'live',
          GENERATION_ENABLED: 'true',
          ...workerPublicVars,
        },
      },
    ],
    [{ secrets: { required: ['SUPABASE_SECRET_KEY'] } }],
    [{ queues: { producers: [{ binding: 'GENERATION_QUEUE' }], consumers: [] } }],
    [{ triggers: { crons: ['* * * * *', '0 15 * * *'] } }],
    [
      {
        vars: {
          APP_ENV: 'production',
          DATA_MODE: 'live',
          AI_MODE: 'live',
          GENERATION_ENABLED: 'false',
          ...workerPublicVars,
          OPENAI_API_KEY: 'unexpected',
        },
      },
    ],
  ])('rejects unsafe connected config changes before deployment', async (overrides) => {
    const root = await createArtifact(overrides);
    await expect(
      prepareProductionConnectedReleaseArtifact(commit, workerPublicVars, publicValues, root),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CONFIG_UNSAFE' });
  });
});

describe('production connected Wrangler deploy', () => {
  it.each([false, true])(
    'passes one atomic secrets-file deploy and cleans up (generation profile=%s)',
    async (infra) => {
      const profile = selectProductionConnectedProfile(infra ? 'true' : 'false');
      const secrets = {
        ...privateValues,
        ...(infra
          ? { OPENAI_API_KEY: 'sk-project-private-sentinel', GENERATION_ALLOWED_OWNER_ID: 'all' }
          : {}),
      };
      const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-secret-test-'));
      temporaryDirectories.push(root);
      const observed: {
        args?: string[];
        options?: WranglerExecutionOptions;
        fileContents?: string;
        mode?: number;
      } = {};
      await runWranglerProductionConnectedDeploy(
        '/tmp/wrangler.json',
        'cf-token-sentinel',
        secrets,
        {
          temporaryRoot: root,
          async executor(_file, args, options) {
            observed.args = args;
            observed.options = options;
            const secretsFile = args[args.indexOf('--secrets-file') + 1]!;
            observed.fileContents = await readFile(secretsFile, 'utf8');
            observed.mode = (await stat(secretsFile)).mode & 0o777;
            return { stdout: 'do-not-print', stderr: 'private-output' };
          },
        },
        profile,
      );
      expect(observed.args).toContain('--secrets-file');
      expect(observed.mode).toBe(0o600);
      expect(JSON.parse(observed.fileContents!)).toEqual(secrets);
      expect(observed.options?.env.CLOUDFLARE_API_TOKEN).toBe('cf-token-sentinel');
      expect(observed.options?.env.SUPABASE_SECRET_KEY).toBeUndefined();
      expect(observed.options?.env.TURNSTILE_SECRET_KEY).toBeUndefined();
      expect(observed.options?.env.OPENAI_API_KEY).toBeUndefined();
      expect(observed.options?.env.BWS_ACCESS_TOKEN).toBeUndefined();
      expect(await (await import('node:fs/promises')).readdir(root)).toEqual([]);
    },
  );

  it('cleans the private secrets file after a failed deploy and suppresses child error text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-production-secret-failure-'));
    temporaryDirectories.push(root);
    await expect(
      runWranglerProductionConnectedDeploy(
        '/tmp/wrangler.json',
        'cf-token-sentinel',
        privateValues,
        {
          temporaryRoot: root,
          async executor() {
            throw new Error('secret-output-sentinel');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'WRANGLER_DEPLOY_FAILED' });
    expect(await (await import('node:fs/promises')).readdir(root)).toEqual([]);
  });
});

describe('production generation deployment profile', () => {
  it('keeps one-message batches and bounded retries while using ten consumers', () => {
    expect(productionGenerationQueueConfiguration('fixture-generations')).toEqual({
      producers: [{ binding: 'GENERATION_QUEUE', queue: 'fixture-generations' }],
      consumers: [
        {
          queue: 'fixture-generations',
          max_batch_size: 1,
          max_batch_timeout: 0,
          max_retries: 3,
          max_concurrency: 10,
        },
      ],
    });
  });

  it('keeps diary-only defaults and rejects implicit or invalid activation', () => {
    expect(selectProductionConnectedProfile().queueName).toBeUndefined();
    expect(selectProductionConnectedProfile('false', 'false').generationEnabled).toBeUndefined();
    expect(() => selectProductionConnectedProfile(undefined, 'true')).toThrow();
    expect(() => selectProductionConnectedProfile('yes')).toThrow();
    expect(() => selectProductionConnectedProfile('true', 'yes')).toThrow();
  });

  it('requires the OpenAI secret only with infrastructure enabled', () => {
    const profile = selectProductionConnectedProfile('true', 'false');
    expect(profile.generationEnabled).toBe(false);
    expect(() => validateProductionWorkerSecrets(privateValues, profile)).toThrow();
    expect(() =>
      validateProductionWorkerSecrets({
        ...privateValues,
        OPENAI_API_KEY: 'sk-project-sentinel',
        GENERATION_ALLOWED_OWNER_ID: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow();
    expect(
      validateProductionWorkerSecrets(
        {
          ...privateValues,
          OPENAI_API_KEY: 'sk-project-sentinel',
          GENERATION_ALLOWED_OWNER_ID: '11111111-1111-4111-8111-111111111111',
        },
        profile,
      ),
    ).toMatchObject({
      OPENAI_API_KEY: 'sk-project-sentinel',
      GENERATION_ALLOWED_OWNER_ID: '11111111-1111-4111-8111-111111111111',
    });
  });

  it.each([undefined, '', 'owner-name', ' all', 'ALL', '11111111-1111-4111-8111-111111111111\n'])(
    'rejects invalid private owner gate without exposing it (%s)',
    (owner) => {
      expect(() =>
        validateProductionWorkerSecrets(
          {
            ...privateValues,
            OPENAI_API_KEY: 'sk-project-sentinel',
            GENERATION_ALLOWED_OWNER_ID: owner,
          },
          selectProductionConnectedProfile('true'),
        ),
      ).toThrow('INPUT_PRIVATE_SECRET_INVALID');
    },
  );

  it.each(['false', 'true'])(
    'accepts only the dedicated queue and exact profile artifact with generation=%s',
    async (enabled) => {
      const profile = selectProductionConnectedProfile('true', enabled);
      const queues = productionGenerationQueueConfiguration(profile.queueName!);
      const root = await createArtifact({
        vars: {
          APP_ENV: 'production',
          DATA_MODE: 'live',
          AI_MODE: 'live',
          GENERATION_ENABLED: enabled,
          ...workerPublicVars,
        },
        triggers: { crons: ['* * * * *', '0 15 * * *'] },
        queues,
        secrets: {
          required: [
            'SUPABASE_SECRET_KEY',
            'TURNSTILE_SECRET_KEY',
            'OPENAI_API_KEY',
            'GENERATION_ALLOWED_OWNER_ID',
          ],
        },
      });
      await expect(
        prepareProductionConnectedReleaseArtifact(
          commit,
          workerPublicVars,
          publicValues,
          root,
          profile,
        ),
      ).resolves.toHaveProperty('configPath');
      await expect(
        prepareProductionConnectedReleaseArtifact(commit, workerPublicVars, publicValues, root),
      ).rejects.toMatchObject({ code: 'ARTIFACT_CONFIG_UNSAFE' });
      const configPath = path.join(root, 'dist/server/wrangler.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.queues.consumers[0].queue = 'other-queue';
      await writeFile(configPath, JSON.stringify(config));
      await expect(
        prepareProductionConnectedReleaseArtifact(
          commit,
          workerPublicVars,
          publicValues,
          root,
          profile,
        ),
      ).rejects.toMatchObject({ code: 'ARTIFACT_CONFIG_UNSAFE' });
    },
  );
});
