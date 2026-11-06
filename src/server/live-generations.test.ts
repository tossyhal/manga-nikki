import { describe, expect, it, vi } from 'vitest';
import { LiveGenerationError, reserveLiveOpenAIGeneration } from './live-generations';
import { mockEnvironment, type Environment } from './mode';

describe('live generation RPC errors', () => {
  it('maps a succeeded-revision reservation rejection to a conflict', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      SUPABASE_URL: 'https://generation-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'demo.example',
      OPENAI_API_KEY: 'provider-key-for-test-only',
      GENERATION_QUEUE: queue,
    };
    const rpcCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const name = new URL(request.url).pathname.split('/').at(-1) ?? '';
      rpcCalls.push(name);
      if (name === 'find_generation_receipt') return Response.json(null);
      if (name === 'reserve_openai_generation')
        return Response.json(
          {
            code: 'P0001',
            message: 'REVISION_ALREADY_GENERATED',
            details: null,
            hint: null,
          },
          { status: 400 },
        );
      throw new Error(`unexpected RPC: ${name}`);
    };
    const turnstileFetch: typeof fetch = async () =>
      Response.json({ success: true, action: 'generate', hostname: 'demo.example' });

    await expect(
      reserveLiveOpenAIGeneration(
        {
          environment,
          owner: 'aaaaaaaa-1111-4111-8111-111111111111',
          accessToken: 'test-access-token',
          fetcher,
          turnstileFetch,
        },
        {
          entryId: 'bbbbbbbb-2222-4222-8222-222222222222',
          expectedRevision: 1,
          idempotencyKey: 'cccccccc-3333-4333-8333-333333333333',
          captchaToken: 'test-captcha',
        },
        true,
        true,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_ALREADY_GENERATED',
    } satisfies Partial<LiveGenerationError>);

    expect(rpcCalls).toEqual(['find_generation_receipt', 'reserve_openai_generation']);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
