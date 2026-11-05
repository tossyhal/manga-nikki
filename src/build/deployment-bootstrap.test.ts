import { describe, expect, it } from 'vitest';
import {
  BootstrapFailure,
  STAGING_ACCOUNT_ID,
  STAGING_CONFIRMATION,
  STAGING_WORKER_NAME,
  renderBootstrapSummary,
  runDeploymentBootstrap,
  type BootstrapContext,
  type BootstrapDisplayErrorCode,
  type BootstrapErrorCode,
  type BootstrapProgress,
} from './deployment-bootstrap';

const tokenSentinel = 'cloudflare-token-test-sentinel';

function context(overrides: Partial<BootstrapContext> = {}): BootstrapContext {
  return {
    githubActions: 'true',
    githubRepository: 'tossyhal/manga-nikki',
    githubRef: 'refs/heads/main',
    operation: 'check',
    confirmation: '',
    exclusiveSetup: 'false',
    cloudflareApiToken: tokenSentinel,
    ...overrides,
  };
}

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function missingWorkerResponse(): Response {
  return apiResponse(
    { success: false, errors: [{ code: 10007, message: `missing ${tokenSentinel}` }] },
    404,
  );
}

function presentWorkerResponse(): Response {
  return apiResponse({ success: true, result: { bindings: [] } });
}

function subdomainResponse(enabled = false, previewsEnabled = false): Response {
  return apiResponse({
    success: true,
    result: { enabled, previews_enabled: previewsEnabled },
  });
}

function fakeFetcher(responses: Array<Response | Error>): {
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ input: string; init: RequestInit }>;
} {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  return {
    calls,
    async fetcher(input, init) {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('no fake response');
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

async function failureCode(run: Promise<unknown>): Promise<BootstrapErrorCode> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapFailure);
    return (error as BootstrapFailure).code;
  }
  throw new Error('expected bootstrap failure');
}

describe('staging Worker bootstrap', () => {
  it('checkはmissingを確認して終了し、runnerやmutationを呼ばない', async () => {
    const { fetcher, calls } = fakeFetcher([missingWorkerResponse()]);
    let deployCalls = 0;

    const result = await runDeploymentBootstrap(context(), {
      fetcher,
      async deploy() {
        deployCalls += 1;
      },
    });

    expect(result).toEqual({
      operation: 'check',
      existence: 'missing',
      creation: 'not-requested',
      publicUrlCheck: 'not-applicable',
    });
    expect(deployCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.input).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}/workers/scripts/${STAGING_WORKER_NAME}/settings`,
    );
  });

  it('HTTP 404や別のCloudflare codeをWorkerなしと誤認しない', async () => {
    for (const response of [
      apiResponse({ success: false, errors: [{ code: 1000 }] }, 404),
      apiResponse({ success: false, errors: [{ code: 10007 }] }, 403),
      apiResponse({ success: true, errors: [{ code: 10007 }] }, 404),
    ]) {
      const { fetcher } = fakeFetcher([response]);
      await expect(runDeploymentBootstrap(context(), { fetcher })).rejects.toMatchObject({
        code: 'CLOUDFLARE_API_FAILED',
      });
    }
  });

  it('Cloudflare認証・通信失敗は一般化し、本文やtokenをerrorへ出さない', async () => {
    const unauthorized = apiResponse(
      { success: false, errors: [{ code: 10000, message: tokenSentinel }] },
      401,
    );
    const unauthorizedFetcher = fakeFetcher([unauthorized]);
    expect(
      await failureCode(
        runDeploymentBootstrap(context(), { fetcher: unauthorizedFetcher.fetcher }),
      ),
    ).toBe('CLOUDFLARE_API_FAILED');

    const networkFetcher = fakeFetcher([new Error(tokenSentinel)]);
    expect(
      await failureCode(runDeploymentBootstrap(context(), { fetcher: networkFetcher.fetcher })),
    ).toBe('CLOUDFLARE_REQUEST_FAILED');
  });

  it('既存Workerへのcreateは上書きせず、即時停止する', async () => {
    const { fetcher, calls } = fakeFetcher([presentWorkerResponse()]);
    let deployCalls = 0;

    expect(
      await failureCode(
        runDeploymentBootstrap(
          context({
            operation: 'create',
            confirmation: STAGING_CONFIRMATION,
            exclusiveSetup: 'true',
          }),
          {
            fetcher,
            async deploy() {
              deployCalls += 1;
            },
          },
        ),
      ),
    ).toBe('WORKER_ALREADY_EXISTS');
    expect(deployCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('missing createは固定の最小設定を一度だけdeployし、公開URLを検査する', async () => {
    const { fetcher, calls } = fakeFetcher([
      missingWorkerResponse(),
      presentWorkerResponse(),
      subdomainResponse(),
    ]);
    const plans: Array<{ workerSource: string; wranglerConfig: string }> = [];

    const result = await runDeploymentBootstrap(
      context({
        operation: 'create',
        confirmation: STAGING_CONFIRMATION,
        exclusiveSetup: 'true',
      }),
      {
        fetcher,
        async deploy(plan) {
          plans.push(plan);
        },
      },
    );

    expect(result).toEqual({
      operation: 'create',
      existence: 'present',
      creation: 'completed',
      publicUrlCheck: 'passed',
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.workerSource).toContain('status: 503');
    const config = JSON.parse(plans[0]?.wranglerConfig ?? '{}') as Record<string, unknown>;
    expect(config).toMatchObject({
      name: STAGING_WORKER_NAME,
      account_id: STAGING_ACCOUNT_ID,
      main: 'worker.mjs',
      compatibility_date: '2026-10-26',
      workers_dev: false,
      preview_urls: false,
      routes: [],
      triggers: { crons: [] },
    });
    expect(config).not.toHaveProperty('vars');
    expect(config).not.toHaveProperty('bindings');
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls[2]?.input).toContain('/subdomain');
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('確認文字列・repository・refを拒否し、Cloudflareへ接続しない', async () => {
    const invalidContexts = [
      context({ operation: 'create', confirmation: 'wrong', exclusiveSetup: 'true' }),
      context({ githubRepository: 'someone-else/manga-nikki' }),
      context({ githubRef: 'refs/heads/feature/test' }),
      context({ githubActions: 'false' }),
    ];

    for (const input of invalidContexts) {
      const { fetcher, calls } = fakeFetcher([]);
      await expect(runDeploymentBootstrap(input, { fetcher })).rejects.toBeInstanceOf(
        BootstrapFailure,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it('createはexclusive setupの明示確認をsecret検証・fetchより先に要求する', async () => {
    const invalidContexts = [
      context({
        operation: 'create',
        confirmation: STAGING_CONFIRMATION,
        exclusiveSetup: 'false',
        cloudflareApiToken: undefined,
      }),
      context({
        operation: 'create',
        confirmation: STAGING_CONFIRMATION,
        exclusiveSetup: undefined,
        cloudflareApiToken: undefined,
      }),
    ];

    for (const input of invalidContexts) {
      const { fetcher, calls } = fakeFetcher([]);
      expect(await failureCode(runDeploymentBootstrap(input, { fetcher }))).toBe(
        'INPUT_EXCLUSIVE_SETUP_REQUIRED',
      );
      expect(calls).toHaveLength(0);
    }
  });

  it('周囲に空白があるCloudflare tokenを拒否し、値をerrorへ含めない', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const error = await failureCode(
      runDeploymentBootstrap(context({ cloudflareApiToken: ` ${tokenSentinel} ` }), { fetcher }),
    );

    expect(error).toBe('CLOUDFLARE_TOKEN_INVALID');
    expect(calls).toHaveLength(0);
    expect(error).not.toContain(tokenSentinel);
  });

  it('Workerが見つからない場合と異なり、公開URLが有効ならcheckを失敗にする', async () => {
    const { fetcher, calls } = fakeFetcher([
      presentWorkerResponse(),
      subdomainResponse(true, false),
    ]);

    expect(await failureCode(runDeploymentBootstrap(context(), { fetcher }))).toBe(
      'WORKER_PUBLIC_URL_ENABLED',
    );
    expect(calls).toHaveLength(2);
  });

  it('作成後にPreview URLが有効なら成功扱いにしない', async () => {
    const { fetcher } = fakeFetcher([
      missingWorkerResponse(),
      presentWorkerResponse(),
      subdomainResponse(false, true),
    ]);

    expect(
      await failureCode(
        runDeploymentBootstrap(
          context({
            operation: 'create',
            confirmation: STAGING_CONFIRMATION,
            exclusiveSetup: 'true',
          }),
          { fetcher, async deploy() {} },
        ),
      ),
    ).toBe('WORKER_PUBLIC_URL_ENABLED');
  });

  it('作成後のrunner/API検証失敗を不明状態のsummaryとして出し、秘密本文を含めない', async () => {
    const errorSentinel = 'token-and-signed-url-test-sentinel';
    const cases: Array<{
      name: string;
      responses: Response[];
      deployFails?: boolean;
      expectedCode: BootstrapErrorCode;
      expectedExistence: BootstrapProgress['existence'];
      expectedCreation: BootstrapProgress['creation'];
    }> = [
      {
        name: 'runner failure',
        responses: [missingWorkerResponse()],
        deployFails: true,
        expectedCode: 'DEPLOY_FAILED',
        expectedExistence: 'unknown',
        expectedCreation: 'attempted',
      },
      {
        name: 'missing after deploy',
        responses: [missingWorkerResponse(), missingWorkerResponse()],
        expectedCode: 'WORKER_MISSING_AFTER_DEPLOY',
        expectedExistence: 'missing',
        expectedCreation: 'completed',
      },
      {
        name: 'Cloudflare API error after deploy',
        responses: [
          missingWorkerResponse(),
          apiResponse({ success: false, errors: [{ code: 10000, message: errorSentinel }] }, 500),
        ],
        expectedCode: 'CLOUDFLARE_API_FAILED',
        expectedExistence: 'unknown',
        expectedCreation: 'completed',
      },
      {
        name: 'non-JSON Cloudflare response',
        responses: [new Response(errorSentinel, { status: 200 })],
        expectedCode: 'CLOUDFLARE_RESPONSE_INVALID',
        expectedExistence: 'unknown',
        expectedCreation: 'not-requested',
      },
      {
        name: 'missing previews_enabled',
        responses: [
          missingWorkerResponse(),
          presentWorkerResponse(),
          apiResponse({ success: true, result: { enabled: false } }),
        ],
        expectedCode: 'CLOUDFLARE_RESPONSE_INVALID',
        expectedExistence: 'present',
        expectedCreation: 'completed',
      },
    ];

    for (const scenario of cases) {
      let progress: BootstrapProgress = {
        operation: 'unknown',
        existence: 'unknown',
        creation: 'not-requested',
        publicUrlCheck: 'not-run',
      };
      const { fetcher } = fakeFetcher(scenario.responses);
      const errorCode = await failureCode(
        runDeploymentBootstrap(
          context({
            operation: 'create',
            confirmation: STAGING_CONFIRMATION,
            exclusiveSetup: 'true',
          }),
          {
            fetcher,
            async deploy() {
              if (scenario.deployFails) throw new Error(errorSentinel);
            },
            onProgress(nextProgress) {
              progress = nextProgress;
            },
          },
        ),
      );
      const summary = renderBootstrapSummary(progress, 'a'.repeat(40), errorCode);

      expect(errorCode, scenario.name).toBe(scenario.expectedCode);
      expect(progress.existence, scenario.name).toBe(scenario.expectedExistence);
      expect(progress.creation, scenario.name).toBe(scenario.expectedCreation);
      expect(summary, scenario.name).toContain(`失敗（${scenario.expectedCode}）`);
      expect(summary, scenario.name).toContain(`Worker存在: \`${scenario.expectedExistence}\``);
      expect(summary, scenario.name).not.toContain(errorSentinel);
    }
  });

  it('error・summary・結果へtokenやCloudflare本文を含めない', async () => {
    const body = `${tokenSentinel} signed-url-test-sentinel`;
    const { fetcher } = fakeFetcher([
      apiResponse({ success: false, errors: [{ code: 10000, message: body }] }, 500),
    ]);
    const error = await failureCode(runDeploymentBootstrap(context(), { fetcher }));
    const summary = renderBootstrapSummary(
      {
        operation: 'check',
        existence: 'unknown',
        creation: 'not-requested',
        publicUrlCheck: 'not-run',
      },
      tokenSentinel,
      'CLOUDFLARE_API_FAILED',
    );

    expect(error).toBe('CLOUDFLARE_API_FAILED');
    expect(summary).not.toContain(tokenSentinel);
    expect(summary).not.toContain('signed-url-test-sentinel');
    expect(summary).toContain(STAGING_ACCOUNT_ID);
    expect(summary).toContain(STAGING_WORKER_NAME);
    expect(summary).toContain('route/custom domain');
  });

  it('未知error codeでも成功にせず、INTERNAL_ERRORへ置換して入力値を隠す', () => {
    const errorSentinel = 'unknown-error-code-secret-sentinel';
    const summary = renderBootstrapSummary(
      {
        operation: 'check',
        existence: 'unknown',
        creation: 'not-requested',
        publicUrlCheck: 'not-run',
      },
      undefined,
      errorSentinel as BootstrapDisplayErrorCode,
    );

    expect(summary).toContain('失敗（INTERNAL_ERROR）');
    expect(summary).not.toContain(errorSentinel);
  });
});
