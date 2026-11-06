import { describe, expect, it } from 'vitest';
import {
  checkProductionSamplePreflight,
  ProductionSamplePreflightFailure,
  type ProductionSamplePreflightContext,
} from './production-sample-preflight';
import { PRODUCTION_SAMPLE_PROFILE, SAMPLE_DEPLOYMENT_REPOSITORY } from './sample-deployment';

const commit = 'a'.repeat(40);
const token = 'github-runner-token';
const cloudflareSecretId = '00000000-0000-4000-8000-000000000001';

function context(overrides: Partial<ProductionSamplePreflightContext> = {}) {
  return {
    githubActions: 'true',
    githubRepository: SAMPLE_DEPLOYMENT_REPOSITORY,
    githubRef: 'refs/heads/main',
    githubEventName: 'push',
    githubSha: commit,
    githubActorId: '92223710',
    githubTriggeringActor: 'tossyhal',
    githubToken: token,
    workerUrl: PRODUCTION_SAMPLE_PROFILE.workerUrl,
    productionSampleCdEnabled: 'true',
    bwsCloudflareSecretId: cloudflareSecretId,
    ...overrides,
  } satisfies ProductionSamplePreflightContext;
}

function headResponse(sha: string) {
  return new Response(JSON.stringify({ object: { sha } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('production sample preflight', () => {
  it('requires the exact production actor, main trigger, target URL, flag, and Secret IDs before API access', async () => {
    const invalidContexts = [
      context({ githubActorId: '123' }),
      context({ githubTriggeringActor: 'someone-else' }),
      context({ githubRef: 'refs/heads/develop' }),
      context({ githubEventName: 'pull_request' }),
      context({ productionSampleCdEnabled: 'false', githubActorId: 'another-actor' }),
      context({ workerUrl: 'https://manga-nikki-staging.tossyhal.workers.dev' }),
      context({ bwsCloudflareSecretId: 'not-a-uuid' }),
    ];

    for (const invalid of invalidContexts) {
      let calls = 0;
      await expect(
        checkProductionSamplePreflight(invalid, {
          async githubFetcher() {
            calls += 1;
            return headResponse(commit);
          },
        }),
      ).rejects.toBeInstanceOf(ProductionSamplePreflightFailure);
      expect(calls).toBe(0);
    }
  });

  it('skips a disabled Environment flag before URL, Cloudflare ID, token, or GitHub API checks', async () => {
    let calls = 0;
    const result = await checkProductionSamplePreflight(
      context({
        productionSampleCdEnabled: undefined,
        workerUrl: undefined,
        bwsCloudflareSecretId: undefined,
        githubToken: undefined,
      }),
      {
        async githubFetcher() {
          calls += 1;
          return headResponse(commit);
        },
      },
    );

    expect(result).toEqual({ commit, deployment: 'skipped', skipReason: 'flag-disabled' });
    expect(calls).toBe(0);
  });

  it('accepts only the latest main SHA and uses a read-only GitHub ref request', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const result = await checkProductionSamplePreflight(context(), {
      async githubFetcher(input, init) {
        calls.push({ input, init });
        return headResponse(commit);
      },
    });

    expect(result).toEqual({ commit, deployment: 'ready' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://api.github.com/repos/tossyhal/manga-nikki/git/ref/heads/main',
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('marks an old main commit as a successful no-op candidate', async () => {
    const result = await checkProductionSamplePreflight(context(), {
      async githubFetcher() {
        return headResponse('b'.repeat(40));
      },
    });
    expect(result).toEqual({ commit, deployment: 'skipped', skipReason: 'stale-main' });
  });
});
