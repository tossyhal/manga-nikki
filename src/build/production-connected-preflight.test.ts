import { describe, expect, it, vi } from 'vitest';
import {
  checkProductionConnectedPreflight,
  ProductionConnectedPreflightFailure,
} from './production-connected-preflight';

const commit = 'a'.repeat(40);
const context = {
  githubActions: 'true',
  githubRepository: 'tossyhal/manga-nikki',
  githubRef: 'refs/heads/main',
  githubEventName: 'workflow_dispatch',
  githubSha: commit,
  githubActorId: '92223710',
  githubTriggeringActor: 'tossyhal',
  githubToken: 'github-runner-token',
  workerUrl: 'https://manga-nikki.tossyhal.workers.dev',
  bwsCloudflareSecretId: '11111111-1111-4111-8111-111111111111',
  bwsSupabasePublishableKeySecretId: '22222222-2222-4222-8222-222222222222',
  bwsSupabaseSecretKeySecretId: '33333333-3333-4333-8333-333333333333',
  bwsTurnstileSiteKeySecretId: '44444444-4444-4444-8444-444444444444',
  bwsTurnstileSecretKeySecretId: '55555555-5555-4555-8555-555555555555',
};

describe('production connected preflight', () => {
  it('skips successfully while disabled without validating IDs or calling GitHub', async () => {
    const githubFetcher = vi.fn();
    const result = await checkProductionConnectedPreflight(
      { ...context, productionConnectedCdEnabled: 'false', bwsCloudflareSecretId: 'invalid' },
      { githubFetcher },
    );
    expect(result).toEqual({
      commit,
      deployment: 'skipped',
      skipReason: 'flag-disabled',
    });
    expect(githubFetcher).not.toHaveBeenCalled();
  });

  it('validates all five secret IDs before GitHub access when enabled', async () => {
    const githubFetcher = vi.fn();
    expect(() =>
      checkProductionConnectedPreflight(
        { ...context, productionConnectedCdEnabled: 'true', bwsTurnstileSecretKeySecretId: 'bad' },
        { githubFetcher },
      ),
    ).toThrow(ProductionConnectedPreflightFailure);
    expect(githubFetcher).not.toHaveBeenCalled();
  });

  it('requires an OpenAI Secret ID before any network call only for the generation profile', () => {
    const githubFetcher = vi.fn();
    expect(() =>
      checkProductionConnectedPreflight(
        { ...context, productionConnectedCdEnabled: 'true', infrastructureEnabled: 'true' },
        { githubFetcher },
      ),
    ).toThrow(ProductionConnectedPreflightFailure);
    expect(githubFetcher).not.toHaveBeenCalled();
  });

  it.each(['all', '11111111-1111-4111-8111-111111111111'])(
    'accepts an explicit generation owner gate (%s)',
    async (owner) => {
      const githubFetcher = vi.fn(
        async () => new Response(JSON.stringify({ object: { sha: commit } }), { status: 200 }),
      );
      await expect(
        checkProductionConnectedPreflight(
          {
            ...context,
            productionConnectedCdEnabled: 'true',
            infrastructureEnabled: 'true',
            allowedOwnerId: owner,
            bwsOpenaiApiKeySecretId: '66666666-6666-4666-8666-666666666666',
          },
          { githubFetcher },
        ),
      ).resolves.toMatchObject({ deployment: 'ready' });
    },
  );

  it('checks the latest main SHA only after validating the fixed production target', async () => {
    const githubFetcher = vi.fn(
      async () => new Response(JSON.stringify({ object: { sha: commit } }), { status: 200 }),
    );
    const result = await checkProductionConnectedPreflight(
      { ...context, productionConnectedCdEnabled: 'true' },
      { githubFetcher },
    );
    expect(result).toEqual({ commit, deployment: 'ready' });
    expect(githubFetcher).toHaveBeenCalledTimes(1);
    await expect(
      checkProductionConnectedPreflight(
        { ...context, productionConnectedCdEnabled: 'true', workerUrl: 'https://other.invalid' },
        { githubFetcher },
      ),
    ).rejects.toMatchObject({ code: 'INPUT_WORKER_URL_INVALID' });
    expect(githubFetcher).toHaveBeenCalledTimes(1);
  });
});
