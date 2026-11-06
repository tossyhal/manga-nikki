import { describe, expect, it, vi } from 'vitest';
import {
  getLiveGenerationQuota,
  LiveGenerationError,
  reserveLiveOpenAIGeneration,
} from './live-generations';
import { mockEnvironment, type Environment } from './mode';

describe('live generation RPC errors', () => {
  it('blocks a new disallowed owner before CAPTCHA and reservation but preserves receipts', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      SUPABASE_URL: 'https://generation-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const receipt = {
      generation_id: 'dddddddd-4444-4444-8444-444444444444',
      status: 'queued',
      status_url: '/api/v1/generations/dddddddd-4444-4444-8444-444444444444',
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(null));
    const turnstileFetch = vi.fn<typeof fetch>();
    const context = {
      environment,
      owner: 'aaaaaaaa-1111-4111-8111-111111111111',
      accessToken: 'test-token',
      fetcher,
      turnstileFetch,
    };
    const input = {
      entryId: 'bbbbbbbb-2222-4222-8222-222222222222',
      expectedRevision: 1,
      idempotencyKey: 'cccccccc-3333-4333-8333-333333333333',
      captchaToken: 'test-captcha',
    };
    await expect(reserveLiveOpenAIGeneration(context, input, true, true)).rejects.toMatchObject({
      status: 503,
      code: 'GENERATION_DISABLED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(turnstileFetch).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json(receipt));
    await expect(reserveLiveOpenAIGeneration(context, input, true, true)).resolves.toMatchObject({
      generationId: receipt.generation_id,
    });
    expect(turnstileFetch).not.toHaveBeenCalled();
  });

  it('hides live availability from a disallowed owner even when the DB permits generation', async () => {
    const context = {
      environment: {
        ...mockEnvironment,
        APP_ENV: 'production' as const,
        SUPABASE_URL: 'https://generation-test.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_test',
      },
      owner: 'aaaaaaaa-1111-4111-8111-111111111111',
      accessToken: 'test-token',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          remaining_today: 1,
          active_generation_id: null,
          reset_at: '2026-11-07T00:00:00Z',
          generation_available: true,
          profile_is_mock: false,
        }),
      ),
    };
    await expect(getLiveGenerationQuota(context, true, false)).resolves.toMatchObject({
      generationAvailable: false,
    });
  });

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
