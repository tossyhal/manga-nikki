import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_SAMPLE_ACCOUNT_ID,
  PRODUCTION_SAMPLE_WORKER_NAME,
  PRODUCTION_SAMPLE_WORKER_URL,
  runProductionSampleDeployment,
  renderProductionSampleDeploymentSummary,
  ProductionSampleDeploymentFailure,
  type ProductionSampleDeploymentContext,
  type ProductionSampleDeploymentDependencies,
  type ProductionSampleDeploymentProgress,
} from './production-sample-deployment';

const commit = 'a'.repeat(40);
const githubToken = 'github-runner-token';
const cloudflareToken = 'cloudflare-runner-token';

function context(
  overrides: Partial<ProductionSampleDeploymentContext> = {},
): ProductionSampleDeploymentContext {
  return {
    githubActions: 'true',
    githubRepository: 'tossyhal/manga-nikki',
    githubRef: 'refs/heads/main',
    githubEventName: 'push',
    githubSha: commit,
    githubActorId: '92223710',
    githubTriggeringActor: 'tossyhal',
    githubToken,
    cloudflareApiToken: cloudflareToken,
    workerUrl: PRODUCTION_SAMPLE_WORKER_URL,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function workerSettings(bindings: unknown[] = []): Response {
  return jsonResponse({ success: true, result: { bindings } });
}

function workerBindings(): unknown[] {
  return [
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'APP_ENV', text: 'production' },
    { type: 'plain_text', name: 'DATA_MODE', text: 'sample' },
    { type: 'plain_text', name: 'AI_MODE', text: 'mock' },
    { type: 'plain_text', name: 'GENERATION_ENABLED', text: 'false' },
  ];
}

function jsonHead(sha: string): Response {
  return jsonResponse({ object: { sha } });
}

function queueFetcher(responses: Response[]) {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  return {
    calls,
    async fetcher(input: string, init: RequestInit) {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('No mock response');
      return response;
    },
  };
}

function dependencies(overrides: Partial<ProductionSampleDeploymentDependencies> = {}) {
  const github = queueFetcher([jsonHead(commit), jsonHead(commit)]);
  const cloudflare = queueFetcher([
    workerSettings(),
    workerSettings(workerBindings()),
    jsonResponse({ success: true, result: { enabled: true, previews_enabled: false } }),
  ]);
  const publicCalls: string[] = [];
  const deployCalls: string[] = [];
  const publicFetcher = async (input: string) => {
    publicCalls.push(input);
    if (input.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok', version: '0.1.0' });
    if (input.endsWith('/api/v1/config')) {
      return jsonResponse({ dataMode: 'sample', generationAvailable: false });
    }
    if (input.endsWith('/__deployment.json')) {
      return jsonResponse({ environment: 'production', commit, dataMode: 'sample' });
    }
    throw new Error('Unexpected smoke endpoint');
  };
  const all: ProductionSampleDeploymentDependencies = {
    githubFetcher: github.fetcher,
    cloudflareFetcher: cloudflare.fetcher,
    publicFetcher,
    async prepareArtifact() {
      return { configPath: '/repo/dist/manga_nikki/wrangler.json' };
    },
    async deploy(configPath) {
      deployCalls.push(configPath);
    },
    async sleep() {},
    ...overrides,
  };
  return { all, github, cloudflare, publicCalls, deployCalls };
}

async function failureCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProductionSampleDeploymentFailure);
    return (error as ProductionSampleDeploymentFailure).code;
  }
  throw new Error('Expected production sample deployment failure');
}

describe('production sample deployment guard', () => {
  it('deploys only the fixed production Worker and performs read-only Cloudflare checks', async () => {
    const { all, github, cloudflare, publicCalls, deployCalls } = dependencies();
    let progress: ProductionSampleDeploymentProgress | undefined;
    const result = await runProductionSampleDeployment(context(), {
      ...all,
      onProgress(next) {
        progress = next;
      },
    });

    expect(result).toEqual({
      environment: 'production',
      commit,
      url: PRODUCTION_SAMPLE_WORKER_URL,
      deployment: 'succeeded',
      smoke: 'passed',
    });
    expect(progress?.smoke).toBe('passed');
    expect(deployCalls).toEqual(['/repo/dist/manga_nikki/wrangler.json']);
    expect(github.calls.map(({ input }) => input)).toEqual([
      'https://api.github.com/repos/tossyhal/manga-nikki/git/ref/heads/main',
      'https://api.github.com/repos/tossyhal/manga-nikki/git/ref/heads/main',
    ]);
    const productionWorkerPrefix = `https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_SAMPLE_ACCOUNT_ID}/workers/scripts/${PRODUCTION_SAMPLE_WORKER_NAME}`;
    expect(cloudflare.calls.map(({ input }) => input)).toEqual([
      `${productionWorkerPrefix}/settings`,
      `${productionWorkerPrefix}/settings`,
      `${productionWorkerPrefix}/subdomain`,
    ]);
    expect(cloudflare.calls.every(({ init }) => init.method === 'GET')).toBe(true);
    expect(cloudflare.calls.every(({ input }) => !input.includes('staging'))).toBe(true);
    expect(
      cloudflare.calls.every(({ input }) => input.includes(PRODUCTION_SAMPLE_ACCOUNT_ID)),
    ).toBe(true);
    expect(publicCalls).toEqual([
      `${PRODUCTION_SAMPLE_WORKER_URL}/api/v1/health`,
      `${PRODUCTION_SAMPLE_WORKER_URL}/api/v1/config`,
      `${PRODUCTION_SAMPLE_WORKER_URL}/__deployment.json`,
    ]);
    expect(publicCalls.every((url) => !url.includes('staging'))).toBe(true);
  });

  it('blocks another actor, branch, event, Worker URL, or repository before any API call', async () => {
    const invalidContexts = [
      context({ githubActorId: 'other' }),
      context({ githubTriggeringActor: 'other' }),
      context({ githubRef: 'refs/heads/develop' }),
      context({ githubEventName: 'pull_request' }),
      context({ githubRepository: 'other/manga-nikki' }),
      context({ workerUrl: 'https://manga-nikki-staging.tossyhal.workers.dev' }),
    ];

    for (const invalid of invalidContexts) {
      const calls = { github: 0, cloudflare: 0, prepare: 0, deploy: 0 };
      await expect(
        runProductionSampleDeployment(invalid, {
          async githubFetcher() {
            calls.github += 1;
            return jsonHead(commit);
          },
          async cloudflareFetcher() {
            calls.cloudflare += 1;
            return workerSettings();
          },
          async prepareArtifact() {
            calls.prepare += 1;
            return { configPath: '/unused' };
          },
          async deploy() {
            calls.deploy += 1;
          },
        }),
      ).rejects.toBeInstanceOf(ProductionSampleDeploymentFailure);
      expect(calls).toEqual({ github: 0, cloudflare: 0, prepare: 0, deploy: 0 });
    }
  });

  it('treats a stale main SHA as a successful no-op before Cloudflare access', async () => {
    const cloudflare = queueFetcher([workerSettings()]);
    const result = await runProductionSampleDeployment(context({ cloudflareApiToken: undefined }), {
      githubFetcher: async () => jsonHead('b'.repeat(40)),
      cloudflareFetcher: cloudflare.fetcher,
      async prepareArtifact() {
        throw new Error('must not prepare');
      },
    });

    expect(result.deployment).toBe('skipped');
    expect(result.smoke).toBe('not-run');
    expect(cloudflare.calls).toHaveLength(0);
    const summary = renderProductionSampleDeploymentSummary(result, undefined);
    expect(summary).toContain('Production sample CD');
    expect(summary).toContain('`skipped`');
    expect(summary).toContain(PRODUCTION_SAMPLE_WORKER_URL);
    expect(summary).not.toContain(cloudflareToken);
  });

  it('rechecks main immediately before deploy and skips when it advanced after serialization', async () => {
    const github = queueFetcher([jsonHead(commit), jsonHead('b'.repeat(40))]);
    const cloudflare = queueFetcher([workerSettings()]);
    const deployCalls: string[] = [];
    const result = await runProductionSampleDeployment(context(), {
      githubFetcher: github.fetcher,
      cloudflareFetcher: cloudflare.fetcher,
      async prepareArtifact() {
        return { configPath: '/unused' };
      },
      async deploy(configPath) {
        deployCalls.push(configPath);
      },
    });

    expect(result.deployment).toBe('skipped');
    expect(github.calls).toHaveLength(2);
    expect(cloudflare.calls).toHaveLength(1);
    expect(cloudflare.calls[0]?.init.method).toBe('GET');
    expect(deployCalls).toHaveLength(0);
  });

  it('refuses to overwrite a Worker that already has an unknown binding', async () => {
    const cloudflare = queueFetcher([workerSettings([{ type: 'queue', name: 'FOREIGN_QUEUE' }])]);
    const deployCalls: string[] = [];
    const setup = dependencies({ cloudflareFetcher: cloudflare.fetcher });
    const code = await failureCode(
      runProductionSampleDeployment(context(), {
        ...setup.all,
        async deploy(configPath) {
          deployCalls.push(configPath);
        },
      }),
    );

    expect(code).toBe('WORKER_BINDINGS_PRESENT');
    expect(deployCalls).toHaveLength(0);
    expect(cloudflare.calls).toHaveLength(1);
  });

  it('reports a fixed summary without raw tokens or unvalidated URLs', () => {
    const summary = renderProductionSampleDeploymentSummary(
      {
        environment: 'production',
        commit,
        url: 'https://foreign.example.invalid',
        deployment: 'skipped',
        smoke: 'not-run',
      },
      undefined,
    );
    expect(summary).toContain('- Environment: `production`');
    expect(summary).toContain('URL: 未設定');
    expect(summary).toContain('- Cloudflare version ID: 未取得');
    expect(summary).not.toContain(githubToken);
    expect(summary).not.toContain(cloudflareToken);
  });
});
