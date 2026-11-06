import { describe, expect, it, vi } from 'vitest';
import {
  runProductionConnectedDeployment,
  type ProductionConnectedDeploymentContext,
} from './production-connected-deployment-runner';
import { PRODUCTION_WORKER_HOSTNAME, PRODUCTION_SUPABASE_URL } from './public-config-guard';

const commit = 'b'.repeat(40);
const publicValues = {
  VITE_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_live-smoke-sentinel',
  VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAAprod-smoke-123456',
};
const workerVars = [
  { type: 'plain_text', name: 'APP_ENV', text: 'production' },
  { type: 'plain_text', name: 'DATA_MODE', text: 'live' },
  { type: 'plain_text', name: 'AI_MODE', text: 'live' },
  { type: 'plain_text', name: 'GENERATION_ENABLED', text: 'false' },
  { type: 'plain_text', name: 'SUPABASE_URL', text: PRODUCTION_SUPABASE_URL },
  {
    type: 'plain_text',
    name: 'SUPABASE_PUBLISHABLE_KEY',
    text: publicValues.VITE_SUPABASE_PUBLISHABLE_KEY,
  },
  { type: 'plain_text', name: 'TURNSTILE_ALLOWED_HOSTNAMES', text: PRODUCTION_WORKER_HOSTNAME },
];
const workerSecrets = [
  { type: 'secret_text', name: 'SUPABASE_SECRET_KEY' },
  { type: 'secret_text', name: 'TURNSTILE_SECRET_KEY' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function settings(bindings: unknown[]): Response {
  return json({ success: true, result: { bindings } });
}

function context(
  overrides: Partial<ProductionConnectedDeploymentContext> = {},
): ProductionConnectedDeploymentContext {
  return {
    githubActions: 'true',
    githubRepository: 'tossyhal/manga-nikki',
    githubRef: 'refs/heads/main',
    githubEventName: 'push',
    githubSha: commit,
    githubActorId: '92223710',
    githubTriggeringActor: 'tossyhal',
    githubToken: 'github-runner-token',
    cloudflareApiToken: 'cloudflare-runner-token',
    workerUrl: 'https://manga-nikki.tossyhal.workers.dev',
    releasePublicValues: publicValues,
    ...overrides,
  };
}

describe('production connected deployment guard', () => {
  it.each([
    [undefined, undefined, false],
    ['true', 'false', false],
    ['true', 'true', false],
    ['true', 'true', true],
  ])(
    'checks exact bindings and DB stop for infra=%s enabled=%s available=%s',
    async (infra, enabled, available) => {
      const githubResponses = [
        json({ object: { sha: commit } }),
        json({ object: { sha: commit } }),
      ];
      const cloudflareResponses = [
        settings([
          { type: 'plain_text', name: 'APP_ENV', text: 'production' },
          { type: 'plain_text', name: 'DATA_MODE', text: 'sample' },
          { type: 'plain_text', name: 'AI_MODE', text: 'mock' },
          { type: 'plain_text', name: 'GENERATION_ENABLED', text: 'false' },
        ]),
        settings([
          ...workerVars.map((binding) =>
            binding.name === 'GENERATION_ENABLED'
              ? { ...binding, text: enabled ?? 'false' }
              : binding,
          ),
          ...workerSecrets,
          ...(infra
            ? [
                { type: 'secret_text', name: 'OPENAI_API_KEY' },
                { type: 'secret_text', name: 'GENERATION_ALLOWED_OWNER_ID' },
                {
                  type: 'queue',
                  name: 'GENERATION_QUEUE',
                  queue_name: 'manga-nikki-generations-production',
                },
              ]
            : []),
          { type: 'assets', name: 'ASSETS' },
        ]),
        json({ success: true, result: { enabled: true, previews_enabled: false } }),
      ];
      const events: string[] = [];
      const githubFetcher = vi.fn(async () => githubResponses.shift()!);
      const cloudflareFetcher = vi.fn(async () => cloudflareResponses.shift()!);
      const publicFetcher = vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/api/v1/health')) return json({ status: 'ok' });
        if (input.endsWith('/api/v1/config')) {
          return json({ dataMode: 'live', generationAvailable: available });
        }
        if (input.endsWith(`/api/v1/shared/${'0'.repeat(64)}`)) {
          expect(init).toMatchObject({
            method: 'GET',
            cache: 'no-store',
            redirect: 'error',
          });
          return json({ error: { code: 'NOT_FOUND' } }, 404);
        }
        return json({ environment: 'production', commit, dataMode: 'live' });
      });

      const result = await runProductionConnectedDeployment(
        context({ infrastructureEnabled: infra, generationEnabled: enabled }),
        {
          githubFetcher,
          cloudflareFetcher,
          publicFetcher,
          async prepareArtifact() {
            events.push('prepare');
            return { configPath: '/dist/manga-nikki/wrangler.json' };
          },
          async beforeDeploy() {
            events.push('probe');
          },
          async deploy(configPath) {
            expect(configPath).toBe('/dist/manga-nikki/wrangler.json');
            events.push('deploy');
          },
          async sleep() {},
        },
      );

      expect(result).toEqual({
        environment: 'production',
        commit,
        url: 'https://manga-nikki.tossyhal.workers.dev',
        deployment: 'succeeded',
        smoke: 'passed',
      });
      expect(events).toEqual(['prepare', 'probe', 'deploy']);
      expect(publicFetcher.mock.calls.map(([url]) => url)).toEqual([
        'https://manga-nikki.tossyhal.workers.dev/api/v1/health',
        'https://manga-nikki.tossyhal.workers.dev/api/v1/config',
        'https://manga-nikki.tossyhal.workers.dev/__deployment.json',
        `https://manga-nikki.tossyhal.workers.dev/api/v1/shared/${'0'.repeat(64)}`,
      ]);
    },
  );

  it.each([
    [503, { error: { code: 'UNAVAILABLE' } }],
    [404, { error: { code: 'OTHER_ERROR' } }],
    [200, { error: { code: 'NOT_FOUND' } }],
  ])(
    'fails production smoke when the missing shared route is not 404 NOT_FOUND',
    async (status, body) => {
      const progress: Array<{ deployment: string; smoke: string }> = [];
      const cloudflareResponses = [
        settings([
          { type: 'plain_text', name: 'APP_ENV', text: 'production' },
          { type: 'plain_text', name: 'DATA_MODE', text: 'sample' },
          { type: 'plain_text', name: 'AI_MODE', text: 'mock' },
          { type: 'plain_text', name: 'GENERATION_ENABLED', text: 'false' },
        ]),
        settings([...workerVars, ...workerSecrets, { type: 'assets', name: 'ASSETS' }]),
        json({ success: true, result: { enabled: true, previews_enabled: false } }),
      ];
      const publicFetcher = vi.fn(async (input: string) => {
        if (input.endsWith('/api/v1/health')) return json({ status: 'ok' });
        if (input.endsWith('/api/v1/config')) {
          return json({ dataMode: 'live', generationAvailable: false });
        }
        if (input.endsWith(`/api/v1/shared/${'0'.repeat(64)}`)) return json(body, status);
        return json({ environment: 'production', commit, dataMode: 'live' });
      });

      await expect(
        runProductionConnectedDeployment(context(), {
          githubFetcher: vi.fn(async () => json({ object: { sha: commit } })),
          cloudflareFetcher: vi.fn(async () => cloudflareResponses.shift()!),
          publicFetcher,
          async prepareArtifact() {
            return { configPath: '/dist/manga-nikki/wrangler.json' };
          },
          async deploy() {},
          async sleep() {},
          onProgress(nextProgress) {
            progress.push({
              deployment: nextProgress.deployment,
              smoke: nextProgress.smoke,
            });
          },
        }),
      ).rejects.toMatchObject({ code: 'SMOKE_RESPONSE_INVALID' });

      expect(publicFetcher.mock.calls.at(-1)?.[0]).toBe(
        `https://manga-nikki.tossyhal.workers.dev/api/v1/shared/${'0'.repeat(64)}`,
      );
      expect(progress.at(-1)).toEqual({ deployment: 'succeeded', smoke: 'failed' });
    },
  );

  it.each([
    [{ type: 'queue', name: 'GENERATION_QUEUE', queue_name: 'other-queue' }],
    [{ type: 'secret_text', name: 'OTHER_KEY' }],
    [
      { type: 'queue', name: 'GENERATION_QUEUE', queue_name: 'manga-nikki-generations-production' },
      { type: 'queue', name: 'GENERATION_QUEUE', queue_name: 'manga-nikki-generations-production' },
    ],
  ])(
    'rejects unexpected or duplicate bindings even with generation infrastructure',
    async (...bindings) => {
      const deploy = vi.fn();
      await expect(
        runProductionConnectedDeployment(context({ infrastructureEnabled: 'true' }), {
          githubFetcher: vi.fn(async () => json({ object: { sha: commit } })),
          cloudflareFetcher: vi.fn(async () => settings(bindings)),
          async prepareArtifact() {
            return { configPath: '/dist/wrangler.json' };
          },
          deploy,
        }),
      ).rejects.toMatchObject({ code: 'WORKER_BINDINGS_PRESENT' });
      expect(deploy).not.toHaveBeenCalled();
    },
  );

  it('blocks unexpected Worker bindings and failed Supabase probes before Wrangler', async () => {
    const initial = [settings([{ type: 'secret_text', name: 'OPENAI_API_KEY' }]), settings([])];
    const githubFetcher = vi.fn(async () => json({ object: { sha: commit } }));
    const cloudflareFetcher = vi.fn(async () => initial.shift()!);
    const deploy = vi.fn();
    const beforeDeploy = vi.fn();
    await expect(
      runProductionConnectedDeployment(context(), {
        githubFetcher,
        cloudflareFetcher,
        async prepareArtifact() {
          return { configPath: '/dist/wrangler.json' };
        },
        beforeDeploy,
        deploy,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_BINDINGS_PRESENT' });
    expect(beforeDeploy).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();

    const probeFailure = await runProductionConnectedDeployment(context(), {
      githubFetcher: vi.fn(async () => json({ object: { sha: commit } })),
      cloudflareFetcher: vi.fn(async () => settings([])),
      async prepareArtifact() {
        return { configPath: '/dist/wrangler.json' };
      },
      async beforeDeploy() {
        throw new Error('private-probe-response');
      },
      async deploy() {
        throw new Error('deploy must not run');
      },
    }).catch((error: unknown) => error);
    expect(probeFailure).toMatchObject({ code: 'SUPABASE_PROBE_FAILED' });
    expect((probeFailure as Error).message).not.toContain('private-probe-response');
  });
});
