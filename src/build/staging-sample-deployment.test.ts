import { describe, expect, it } from 'vitest';
import {
  renderStagingSampleDeploymentSummary,
  runStagingSampleDeployment,
  StagingSampleDeploymentFailure,
  STAGING_SAMPLE_ACCOUNT_ID,
  STAGING_SAMPLE_REPOSITORY,
  STAGING_SAMPLE_WORKER_NAME,
  STAGING_SAMPLE_WORKER_URL,
  type StagingSampleDeploymentContext,
  type StagingSampleDeploymentDependencies,
  type StagingSampleDeploymentErrorCode,
  type StagingSampleDeploymentProgress,
} from './staging-sample-deployment';

const commit = 'a'.repeat(40);
const githubToken = 'github-runner-token';
const cloudflareToken = 'cloudflare-runner-token';

function context(
  overrides: Partial<StagingSampleDeploymentContext> = {},
): StagingSampleDeploymentContext {
  return {
    githubActions: 'true',
    githubRepository: STAGING_SAMPLE_REPOSITORY,
    githubRef: 'refs/heads/develop',
    githubEventName: 'push',
    githubSha: commit,
    githubToken,
    cloudflareApiToken: cloudflareToken,
    workerUrl: STAGING_SAMPLE_WORKER_URL,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function workerSettings(bindings: unknown[] = []): Response {
  return jsonResponse({ success: true, result: { bindings } });
}

function missingWorker(): Response {
  return jsonResponse({ success: false, errors: [{ code: 10007, message: cloudflareToken }] }, 404);
}

function appBindings(): unknown[] {
  return [
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'APP_ENV', text: 'staging' },
    { type: 'plain_text', name: 'DATA_MODE', text: 'sample' },
    { type: 'plain_text', name: 'AI_MODE', text: 'mock' },
    { type: 'plain_text', name: 'GENERATION_ENABLED', text: 'false' },
  ];
}

function subdomainSettings(enabled = true, previewsEnabled = false): Response {
  return jsonResponse({
    success: true,
    result: { enabled, previews_enabled: previewsEnabled },
  });
}

function queuedFetcher(responses: Array<Response | Error>): {
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ input: string; init: RequestInit }>;
} {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  return {
    calls,
    async fetcher(input, init) {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('No mock response');
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function githubHead(sha: string): Response {
  return jsonResponse({ object: { sha } });
}

function successPublicFetcher(sha = commit) {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  return {
    calls,
    async fetcher(input: string, init: RequestInit) {
      calls.push({ input, init });
      if (input.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok', version: '0.1.0' });
      if (input.endsWith('/api/v1/config')) {
        return jsonResponse({ dataMode: 'sample', generationAvailable: false });
      }
      if (input.endsWith('/__deployment.json')) {
        return jsonResponse({ environment: 'staging', commit: sha, dataMode: 'sample' });
      }
      throw new Error('Unexpected public URL');
    },
  };
}

function goodDependencies(overrides: Partial<StagingSampleDeploymentDependencies> = {}) {
  const github = queuedFetcher([githubHead(commit), githubHead(commit)]);
  const cloudflare = queuedFetcher([
    workerSettings(),
    workerSettings(appBindings()),
    subdomainSettings(),
  ]);
  const publicApi = successPublicFetcher();
  const deployCalls: string[] = [];
  const dependencies: StagingSampleDeploymentDependencies = {
    githubFetcher: github.fetcher,
    cloudflareFetcher: cloudflare.fetcher,
    publicFetcher: publicApi.fetcher,
    async prepareArtifact() {
      return { configPath: '/repo/dist/manga_nikki/wrangler.json' };
    },
    async deploy(configPath) {
      deployCalls.push(configPath);
    },
    async sleep() {},
    ...overrides,
  };
  return { dependencies, github, cloudflare, publicApi, deployCalls };
}

async function failureCode(promise: Promise<unknown>): Promise<StagingSampleDeploymentErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StagingSampleDeploymentFailure);
    return (error as StagingSampleDeploymentFailure).code;
  }
  throw new Error('Expected staging sample deployment failure');
}

describe('staging sample deployment guard', () => {
  it('allows a current develop deployment, checks fixed settings and smoke endpoints without public auth headers', async () => {
    const { dependencies, github, cloudflare, publicApi, deployCalls } = goodDependencies();
    let progress: StagingSampleDeploymentProgress | undefined;

    const result = await runStagingSampleDeployment(context(), {
      ...dependencies,
      onProgress(next) {
        progress = next;
      },
    });

    expect(result).toEqual({
      environment: 'staging',
      commit,
      url: STAGING_SAMPLE_WORKER_URL,
      deployment: 'succeeded',
      smoke: 'passed',
    });
    expect(deployCalls).toEqual(['/repo/dist/manga_nikki/wrangler.json']);
    expect(github.calls).toHaveLength(2);
    expect(github.calls.every(({ init }) => init.redirect === 'error')).toBe(true);
    expect(cloudflare.calls.map(({ input }) => input)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${STAGING_SAMPLE_ACCOUNT_ID}/workers/scripts/${STAGING_SAMPLE_WORKER_NAME}/settings`,
      `https://api.cloudflare.com/client/v4/accounts/${STAGING_SAMPLE_ACCOUNT_ID}/workers/scripts/${STAGING_SAMPLE_WORKER_NAME}/settings`,
      `https://api.cloudflare.com/client/v4/accounts/${STAGING_SAMPLE_ACCOUNT_ID}/workers/scripts/${STAGING_SAMPLE_WORKER_NAME}/subdomain`,
    ]);
    expect(publicApi.calls.map(({ input }) => input)).toEqual([
      `${STAGING_SAMPLE_WORKER_URL}/api/v1/health`,
      `${STAGING_SAMPLE_WORKER_URL}/api/v1/config`,
      `${STAGING_SAMPLE_WORKER_URL}/__deployment.json`,
    ]);
    expect(
      publicApi.calls.every(({ init }) => init.cache === 'no-store' && init.redirect === 'error'),
    ).toBe(true);
    expect(publicApi.calls.every(({ init }) => init.headers === undefined)).toBe(true);
    expect(progress?.smoke).toBe('passed');
  });

  it('rejects wrong repo, ref, event, action context, SHA, URL, and multiline tokens before network access', async () => {
    const invalidContexts = [
      context({ githubActions: 'false' }),
      context({ githubRepository: 'someone-else/manga-nikki' }),
      context({ githubRef: 'refs/heads/main' }),
      context({ githubEventName: 'pull_request' }),
      context({ githubSha: 'bad-sha' }),
      context({ workerUrl: 'https://manga-nikki-staging.other.workers.dev' }),
      context({ githubToken: `token\n${githubToken}` }),
    ];

    for (const invalidContext of invalidContexts) {
      const { dependencies, github, cloudflare } = goodDependencies();
      await expect(runStagingSampleDeployment(invalidContext, dependencies)).rejects.toBeInstanceOf(
        StagingSampleDeploymentFailure,
      );
      expect(github.calls).toHaveLength(0);
      expect(cloudflare.calls).toHaveLength(0);
    }

    const { dependencies: cfTokenDependencies, github, cloudflare } = goodDependencies();
    await expect(
      runStagingSampleDeployment(
        context({ cloudflareApiToken: 'token\nvalue' }),
        cfTokenDependencies,
      ),
    ).rejects.toMatchObject({ code: 'INPUT_CLOUDFLARE_TOKEN_INVALID' });
    expect(github.calls).toHaveLength(1);
    expect(cloudflare.calls).toHaveLength(0);
  });

  it('accepts ordinary letters r and n in tokens and rejects whitespace without echoing tokens', async () => {
    const github = queuedFetcher([githubHead('b'.repeat(40))]);
    const secret = 'runner-token-sentinel';
    const result = await runStagingSampleDeployment(
      context({ githubToken: secret, githubSha: commit }),
      {
        githubFetcher: github.fetcher,
        async prepareArtifact() {
          return { configPath: '/unused' };
        },
      },
    );
    expect(result.deployment).toBe('skipped');

    const summary = renderStagingSampleDeploymentSummary(
      {
        environment: 'staging',
        commit,
        url: STAGING_SAMPLE_WORKER_URL,
        deployment: 'not-run',
        smoke: 'not-run',
      },
      'INPUT_GITHUB_TOKEN_INVALID',
    );
    expect(summary).not.toContain(secret);
  });

  it('skips a stale commit without a Cloudflare request or deployment', async () => {
    const { dependencies, cloudflare, deployCalls } = goodDependencies({
      githubFetcher: queuedFetcher([githubHead('b'.repeat(40))]).fetcher,
    });
    const result = await runStagingSampleDeployment(
      context({ cloudflareApiToken: undefined }),
      dependencies,
    );

    expect(result.deployment).toBe('skipped');
    expect(cloudflare.calls).toHaveLength(0);
    expect(deployCalls).toHaveLength(0);
    const summary = renderStagingSampleDeploymentSummary(result, undefined);
    expect(summary).toContain('`skipped`');
    expect(summary).not.toContain(githubToken);
  });

  it('rechecks develop immediately before deploy and skips if the branch advanced during preflight', async () => {
    const github = queuedFetcher([githubHead(commit), githubHead('b'.repeat(40))]);
    const cloudflare = queuedFetcher([workerSettings()]);
    const deploy = { calls: 0 };
    const result = await runStagingSampleDeployment(context(), {
      githubFetcher: github.fetcher,
      cloudflareFetcher: cloudflare.fetcher,
      async prepareArtifact() {
        return { configPath: '/unused' };
      },
      async deploy() {
        deploy.calls += 1;
      },
    });

    expect(result.deployment).toBe('skipped');
    expect(github.calls).toHaveLength(2);
    expect(cloudflare.calls).toHaveLength(1);
    expect(deploy.calls).toBe(0);
  });

  it('keeps predeploy failures not-run and preserves attempted when Wrangler outcome is unknown', async () => {
    const predeployCloudflare = queuedFetcher([missingWorker()]);
    const predeploy = goodDependencies({ cloudflareFetcher: predeployCloudflare.fetcher });
    let predeployProgress: StagingSampleDeploymentProgress = {
      environment: 'staging',
      commit,
      url: STAGING_SAMPLE_WORKER_URL,
      deployment: 'not-run',
      smoke: 'not-run',
    };
    const predeployError = await failureCode(
      runStagingSampleDeployment(context(), {
        ...predeploy.dependencies,
        onProgress(next) {
          predeployProgress = next;
        },
      }),
    );
    const predeploySummary = renderStagingSampleDeploymentSummary(
      predeployProgress,
      predeployError,
    );

    expect(predeployError).toBe('WORKER_NOT_FOUND');
    expect(predeployProgress.deployment).toBe('not-run');
    expect(predeploySummary).toContain('Deploy: `not-run`');
    expect(predeploySummary).toContain('Error code: `WORKER_NOT_FOUND`');

    const deployFailure = goodDependencies({
      cloudflareFetcher: queuedFetcher([workerSettings()]).fetcher,
      async deploy() {
        throw new Error('wrangler timeout output sentinel');
      },
    });
    let deployProgress: StagingSampleDeploymentProgress = {
      environment: 'staging',
      commit,
      url: STAGING_SAMPLE_WORKER_URL,
      deployment: 'not-run',
      smoke: 'not-run',
    };
    const deployError = await failureCode(
      runStagingSampleDeployment(context(), {
        ...deployFailure.dependencies,
        onProgress(next) {
          deployProgress = next;
        },
      }),
    );
    const deploySummary = renderStagingSampleDeploymentSummary(deployProgress, deployError);

    expect(deployError).toBe('WRANGLER_DEPLOY_FAILED');
    expect(deployProgress.deployment).toBe('attempted');
    expect(deploySummary).toContain('Deploy: `attempted`');
    expect(deploySummary).toContain('Error code: `WRANGLER_DEPLOY_FAILED`');
    expect(deploySummary).not.toContain('wrangler timeout output sentinel');
  });

  it('fails closed when the existing Worker is missing or has a secret/Queue binding', async () => {
    for (const scenario of [
      { response: missingWorker(), code: 'WORKER_NOT_FOUND' },
      {
        response: workerSettings([{ type: 'secret_text', name: 'PRIVATE', text: cloudflareToken }]),
        code: 'WORKER_BINDINGS_PRESENT',
      },
      {
        response: workerSettings([{ type: 'queue', name: 'GENERATION_QUEUE' }]),
        code: 'WORKER_BINDINGS_PRESENT',
      },
    ] as const) {
      const cloudflare = queuedFetcher([scenario.response]);
      const { dependencies } = goodDependencies({ cloudflareFetcher: cloudflare.fetcher });
      expect(await failureCode(runStagingSampleDeployment(context(), dependencies))).toBe(
        scenario.code,
      );
      expect(cloudflare.calls).toHaveLength(1);
    }
  });

  it('rejects partial or changed deployed variables and public URL settings', async () => {
    const wrongVars = appBindings().slice(0, 3);
    for (const scenario of [
      {
        post: workerSettings(wrongVars),
        subdomain: subdomainSettings(),
        code: 'WORKER_BINDINGS_PRESENT',
      },
      {
        post: workerSettings(appBindings()),
        subdomain: subdomainSettings(false, false),
        code: 'WORKER_PUBLIC_URL_DISABLED',
      },
      {
        post: workerSettings(appBindings()),
        subdomain: subdomainSettings(true, true),
        code: 'WORKER_PREVIEW_URL_ENABLED',
      },
    ] as const) {
      const remote = queuedFetcher([workerSettings(), scenario.post, scenario.subdomain]);
      const { dependencies, deployCalls } = goodDependencies({ cloudflareFetcher: remote.fetcher });
      expect(await failureCode(runStagingSampleDeployment(context(), dependencies))).toBe(
        scenario.code,
      );
      expect(deployCalls).toHaveLength(1);
      expect(remote.calls).toHaveLength(scenario.code === 'WORKER_BINDINGS_PRESENT' ? 2 : 3);
    }
  });

  it('does not accept an Access login HTML response with status 200 and never retries the Wrangler deploy', async () => {
    const { dependencies, deployCalls } = goodDependencies();
    const sleeps: number[] = [];
    const publicCalls = { count: 0 };
    const publicFetcher = async () => {
      publicCalls.count += 1;
      return new Response('<html>Access login page</html>', { status: 200 });
    };
    const finalDependencies = {
      ...dependencies,
      publicFetcher,
      async sleep(ms: number) {
        sleeps.push(ms);
      },
    };

    expect(await failureCode(runStagingSampleDeployment(context(), finalDependencies))).toBe(
      'SMOKE_RETRIES_EXHAUSTED',
    );
    expect(publicCalls.count).toBe(5);
    expect(sleeps).toEqual([3_000, 3_000, 3_000, 3_000]);
    expect(deployCalls).toHaveLength(1);
  });

  it('rejects a deployment marker for a different SHA after bounded public GET retries', async () => {
    const publicApi = successPublicFetcher('b'.repeat(40));
    const { dependencies, deployCalls } = goodDependencies({ publicFetcher: publicApi.fetcher });

    expect(await failureCode(runStagingSampleDeployment(context(), dependencies))).toBe(
      'SMOKE_COMMIT_MISMATCH',
    );
    expect(publicApi.calls).toHaveLength(7);
    expect(deployCalls).toHaveLength(1);
  });

  it('hides token and raw response bodies from errors and summary', async () => {
    const bodySentinel = `${cloudflareToken} raw-response-body-sentinel`;
    const cloudflare = queuedFetcher([
      jsonResponse({ success: false, errors: [{ code: 10000, message: bodySentinel }] }, 500),
    ]);
    const { dependencies } = goodDependencies({ cloudflareFetcher: cloudflare.fetcher });
    const errorCode = await failureCode(runStagingSampleDeployment(context(), dependencies));
    const summary = renderStagingSampleDeploymentSummary(
      {
        environment: 'staging',
        commit,
        url: STAGING_SAMPLE_WORKER_URL,
        deployment: 'not-run',
        smoke: 'not-run',
      },
      errorCode,
    );

    expect(errorCode).toBe('CLOUDFLARE_API_FAILED');
    expect(summary).not.toContain(cloudflareToken);
    expect(summary).not.toContain('raw-response-body-sentinel');
    expect(summary).toContain('Cloudflare version ID: 未取得');
  });
});
