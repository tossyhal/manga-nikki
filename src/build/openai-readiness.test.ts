import { describe, expect, it } from 'vitest';
import {
  checkOpenaiModels,
  checkOpenaiReadinessGate,
  OPENAI_READINESS_MODELS,
} from './openai-readiness';
import { PRODUCTION_SAMPLE_PROFILE } from './sample-deployment';

const key = 'sk-proj_readiness-fixture-only';
const sha = 'a'.repeat(40);
const context = {
  githubActions: 'true',
  githubRepository: 'tossyhal/manga-nikki',
  githubRef: 'refs/heads/main',
  githubEventName: 'workflow_dispatch',
  githubSha: sha,
  githubActorId: '92223710',
  githubTriggeringActor: 'tossyhal',
  githubToken: 'github-fixture',
  workerUrl: PRODUCTION_SAMPLE_PROFILE.workerUrl,
  bwsCloudflareSecretId: '00000000-0000-4000-8000-000000000001',
};

describe('OpenAI model readiness', () => {
  it('checks only the two fixed GET paths with bounded requests', async () => {
    const calls: string[] = [];
    const results = await checkOpenaiModels(key, async (url, init) => {
      calls.push(url);
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({ authorization: `Bearer ${key}`, accept: 'application/json' });
      return Response.json({ id: url.split('/').at(-1), object: 'model' });
    });
    expect(calls).toEqual(
      OPENAI_READINESS_MODELS.map((id) => `https://api.openai.com/v1/models/${id}`),
    );
    expect(results.map(({ code }) => code)).toEqual(['MODEL_VISIBLE', 'MODEL_VISIBLE']);
  });

  it.each([undefined, '', 'sk-admin_fixture-administrative', `${key}\n`, 'not-a-key'])(
    'rejects malformed or admin keys without requesting',
    async (value) => {
      let calls = 0;
      await expect(
        checkOpenaiModels(value, async () => {
          calls++;
          throw new Error();
        }),
      ).rejects.toMatchObject({ code: 'INPUT_API_KEY_INVALID' });
      expect(calls).toBe(0);
    },
  );

  it.each(['sk-svcacct_fixture-service-account', 'sk-unknown_fixture-format'])(
    'does not infer scope from project key prefixes',
    async (value) => {
      expect(
        (await checkOpenaiModels(value, async () => new Response(null, { status: 403 })))[0],
      ).toMatchObject({ code: 'MODEL_HTTP_FAILED', status: 403 });
    },
  );

  it('never exposes provider bodies or raw exceptions', async () => {
    let call = 0;
    const results = await checkOpenaiModels(key, async () => {
      if (call++ === 0) return new Response(`secret ${key}`, { status: 401 });
      throw new Error(`secret ${key}`);
    });
    expect(results).toEqual([
      { model: OPENAI_READINESS_MODELS[0], code: 'MODEL_HTTP_FAILED', status: 401 },
      { model: OPENAI_READINESS_MODELS[1], code: 'MODEL_REQUEST_FAILED', status: null },
    ]);
    expect(JSON.stringify(results)).not.toContain(key);
  });

  it.each([
    'not json',
    JSON.stringify({ id: 'other', object: 'model' }),
    'x'.repeat(16 * 1024 + 1),
  ])('rejects invalid or oversized successful responses', async (body) => {
    const results = await checkOpenaiModels(key, async () => new Response(body));
    expect(results.every(({ code }) => code === 'MODEL_RESPONSE_INVALID')).toBe(true);
  });

  it('reuses owner/main/latest SHA gate and rejects push before API access', async () => {
    const githubFetcher = async () => Response.json({ object: { sha } });
    await expect(checkOpenaiReadinessGate(context, { githubFetcher })).resolves.toBeUndefined();
    for (const override of [
      { githubEventName: 'push' },
      { githubActorId: 'other' },
      { githubTriggeringActor: 'other' },
      { githubRef: 'refs/heads/develop' },
      { bwsCloudflareSecretId: 'bad' },
    ]) {
      let calls = 0;
      await expect(
        checkOpenaiReadinessGate(
          { ...context, ...override },
          {
            githubFetcher: async () => {
              calls++;
              throw new Error();
            },
          },
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
    await expect(
      checkOpenaiReadinessGate(context, {
        githubFetcher: async () => Response.json({ object: { sha: 'b'.repeat(40) } }),
      }),
    ).rejects.toMatchObject({ code: 'STALE_MAIN' });
  });
});
