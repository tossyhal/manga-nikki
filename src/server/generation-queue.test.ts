import { describe, expect, it, vi } from 'vitest';
import scriptSample from '../../docs/contracts/script.example.json';
import { openaiGenerationProfileId } from './ai/openai-generation-profile';
import { openaiImageModelProfile } from './ai/openai-image-provider';
import { openaiScriptModelProfile } from './ai/openai-script-provider';
import type { ProviderCallMetadata, ProviderStage } from './ai/provider-attempts';
import type { ImageProvider, RenderedComic, RenderedPanel } from './ai/image-provider';
import type { SaveGeneratedComic } from './generation-save-handler';
import type { ScriptProvider } from './ai/script-provider';
import { scriptSchema } from './ai/script-schema';
import {
  consumeGenerationQueue,
  processGenerationMessage,
  reconcileGenerationQueue,
} from './generation-queue';
import { mockEnvironment, type Environment } from './mode';

const generationId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';

function environment(queue = { send: vi.fn(async () => undefined) }): Environment {
  return {
    ...mockEnvironment,
    APP_ENV: 'staging',
    DATA_MODE: 'live',
    AI_MODE: 'mock',
    SUPABASE_URL: 'https://queue-test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    GENERATION_QUEUE: queue,
  };
}

function claim(isMock = true, inputSnapshot = '架空のテスト日記') {
  return {
    generation_id: generationId,
    entry_id: '33333333-3333-4333-8333-333333333333',
    owner_id: '44444444-4444-4444-8444-444444444444',
    entry_revision: 1,
    diary_date: '2026-11-04',
    is_mock: isMock,
    input_snapshot: inputSnapshot,
    model_profile_snapshot: {
      profile_id: 'fixed-test-v1',
      is_mock: isMock,
      max_cost_micro_usd: 0,
      max_image_calls: 1,
    },
    claim_token: claimToken,
    deadline_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function openAIClaim() {
  return {
    ...claim(false),
    model_profile_snapshot: {
      profile_id: openaiGenerationProfileId,
      is_mock: false,
      max_cost_micro_usd: 1_000_000,
      max_image_calls: 4,
      provider: 'openai',
      script_model: openaiScriptModelProfile.modelId,
      image_model: openaiImageModelProfile.modelId,
      color_mode: 'monochrome',
    },
  };
}

function rpcFetcher(
  handler: (name: string, body: Record<string, unknown>) => unknown | Promise<unknown>,
  calls: { name: string; body: Record<string, unknown> }[] = [],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const name = new URL(request.url).pathname.split('/').at(-1) ?? '';
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({ name, body });
    return Response.json(await handler(name, body));
  };
}

function queueMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe('scheduled generation reconciliation mode gate', () => {
  it('does not access personal data in sample or malformed modes', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const localMock: Environment = {
      ...environment(queue),
      APP_ENV: 'development',
      DATA_MODE: 'mock',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    };
    const sample: Environment = {
      ...environment(queue),
      APP_ENV: 'production',
      DATA_MODE: 'sample',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    };
    const malformed = { ...environment(queue), DATA_MODE: 'invalid' } as unknown as Environment;

    await reconcileGenerationQueue(localMock, fetcher);
    await reconcileGenerationQueue(sample, fetcher);
    await reconcileGenerationQueue(malformed, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe('generation queue consumer', () => {
  it.each([600, 1000])(
    'completes a claimed mock generation with a %i-code-point supplementary-character snapshot',
    async (codePointCount) => {
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const inputSnapshot = '😀'.repeat(codePointCount);
      const fetcher = rpcFetcher((name, body) => {
        if (name === 'claim_generation') return claim(true, inputSnapshot);
        if (name === 'begin_provider_attempt')
          return {
            attempt_id:
              body.p_stage === 'script'
                ? '55555555-5555-4555-8555-555555555555'
                : '66666666-6666-4666-8666-666666666666',
            generation_id: generationId,
            stage: body.p_stage,
            call_index: 1,
            mode: 'mock',
            is_mock: true,
          };
        if (name === 'finish_provider_attempt')
          return {
            attempt_id: body.p_attempt_id,
            state: 'succeeded',
            request_id: null,
            finished_at: '2026-11-04T00:00:00Z',
            is_mock: true,
          };
        if (name === 'complete_mock_generation')
          return {
            generation_id: generationId,
            status: 'succeeded',
            reservation_state: 'consumed',
          };
        throw new Error(`unexpected rpc: ${name}`);
      }, calls);
      const message = queueMessage({ generationId });

      await consumeGenerationQueue(
        { queue: 'manga-nikki-generations-local-connected', messages: [message] },
        environment(),
        fetcher,
      );

      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(calls.map((call) => call.name)).toEqual([
        'claim_generation',
        'begin_provider_attempt',
        'finish_provider_attempt',
        'begin_provider_attempt',
        'finish_provider_attempt',
        'complete_mock_generation',
      ]);
    },
  );

  it('does not settle a malformed claim without a validated claim token', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const invalidClaim = { ...claim(), claim_token: 'untrusted-token' };
    const fetcher = rpcFetcher((name) => {
      if (name === 'claim_generation') return invalidClaim;
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const message = queueMessage({ generationId });

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [message] },
      environment(),
      fetcher,
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(['claim_generation']);
  });

  it('releases an unsubmitted claim whose snapshot exceeds the code-point limit', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const fetcher = rpcFetcher((name) => {
      if (name === 'claim_generation') return claim(true, '😀'.repeat(1001));
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: generationId,
          status: 'failed',
          reservation_state: 'released',
          released: true,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const message = queueMessage({ generationId });

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [message] },
      environment(),
      fetcher,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(['claim_generation', 'fail_or_hold_generation']);
    expect(calls[1]?.body).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_terminal_status: 'failed',
    });
  });

  it('claims a duplicate delivery once and completes only the fixed mock attempts', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    let claimCount = 0;
    const fetcher = rpcFetcher((name, body) => {
      if (name === 'claim_generation') return claimCount++ === 0 ? claim() : null;
      if (name === 'begin_provider_attempt')
        return {
          attempt_id:
            body.p_stage === 'script'
              ? '55555555-5555-4555-8555-555555555555'
              : '66666666-6666-4666-8666-666666666666',
          generation_id: generationId,
          stage: body.p_stage,
          call_index: 1,
          mode: 'mock',
          is_mock: true,
        };
      if (name === 'finish_provider_attempt')
        return {
          attempt_id: body.p_attempt_id,
          state: 'succeeded',
          request_id: null,
          finished_at: '2026-11-04T00:00:00Z',
          is_mock: true,
        };
      if (name === 'complete_mock_generation')
        return {
          generation_id: generationId,
          status: 'succeeded',
          reservation_state: 'consumed',
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const first = queueMessage({ generationId });
    const duplicate = queueMessage({ generationId });

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [first, duplicate] },
      environment(),
      fetcher,
    );

    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'complete_mock_generation',
      'claim_generation',
    ]);
    expect(calls.filter((call) => call.name === 'begin_provider_attempt')).toHaveLength(2);
    expect(
      calls.filter((call) => call.name === 'begin_provider_attempt').map((call) => call.body),
    ).toEqual([
      {
        p_generation_id: generationId,
        p_claim_token: claimToken,
        p_stage: 'script',
        p_call_index: 1,
        p_generation_enabled: false,
      },
      {
        p_generation_id: generationId,
        p_claim_token: claimToken,
        p_stage: 'images',
        p_call_index: 1,
        p_generation_enabled: false,
      },
    ]);
    const completed = calls.find((call) => call.name === 'complete_mock_generation');
    expect(completed?.body.p_comic_json).toMatchObject({
      schemaVersion: 1,
      visual: { kind: 'page', assetId: generationId, textMode: 'external' },
    });
  });

  it('fails a claimed real-profile job without starting a provider attempt', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const fetcher = rpcFetcher((name) => {
      if (name === 'claim_generation') return claim(false);
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: generationId,
          status: 'failed',
          reservation_state: 'released',
          released: true,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);

    await expect(processGenerationMessage(environment(), generationId, fetcher)).resolves.toBe(
      'ignored',
    );
    expect(calls.map((call) => call.name)).toEqual(['claim_generation', 'fail_or_hold_generation']);
    expect(calls[1]?.body).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_terminal_status: 'failed',
    });
  });

  it('runs one script and four ordered OpenAI image attempts before handing off saving', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const generation = openAIClaim();
    const attemptIds = new Map<string, string>();
    const fetcher = rpcFetcher((name, body) => {
      if (name === 'claim_generation') return generation;
      if (name === 'begin_provider_attempt') {
        const stage = String(body.p_stage);
        const index = Number(body.p_call_index);
        const attemptId = crypto.randomUUID();
        attemptIds.set(`${stage}:${index}`, attemptId);
        return {
          attempt_id: attemptId,
          generation_id: generationId,
          stage,
          call_index: index,
          mode: 'provider',
          is_mock: false,
        };
      }
      if (name === 'finish_provider_attempt')
        return {
          attempt_id: body.p_attempt_id,
          state: body.p_state,
          request_id: body.p_request_id,
          finished_at: new Date().toISOString(),
          is_mock: false,
        };
      if (name === 'mark_generation_saving')
        return { generation_id: generationId, status: 'running', stage: 'saving' };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const script = scriptSchema.parse(structuredClone(scriptSample));
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const metadataFor = (
      stage: ProviderStage,
      callIndex: number,
      modelId: string,
    ): ProviderCallMetadata => ({
      stage,
      callIndex,
      modelId,
      requestId: `${stage}-${callIndex}-request`,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const scriptProvider: ScriptProvider = {
      createScript: async (_input, options) => {
        const attemptId = await options.attemptHooks!.begin('script', 1);
        const metadata = metadataFor('script', 1, openaiScriptModelProfile.modelId);
        await options.attemptHooks!.finish('script', 1, attemptId, {
          state: 'succeeded',
          requestId: metadata.requestId,
          metadata,
        });
        return script;
      },
    };
    const imageProvider: ImageProvider = {
      render: async (_script, options) => {
        const panels: RenderedPanel[] = [];
        for (let callIndex = 1; callIndex <= 4; callIndex++) {
          const attemptId = await options.attemptHooks!.begin('images', callIndex);
          const metadata = metadataFor('images', callIndex, openaiImageModelProfile.modelId);
          await options.attemptHooks!.finish('images', callIndex, attemptId, {
            state: 'succeeded',
            requestId: metadata.requestId,
            metadata,
          });
          panels.push({
            index: callIndex as RenderedPanel['index'],
            mediaType: 'image/png',
            data: png,
          });
        }
        return {
          kind: 'panels' as const,
          textMode: 'external' as const,
          modelId: openaiImageModelProfile.modelId,
          panels: panels as RenderedComic['panels'],
        };
      },
    };
    const saveGeneratedComic = vi.fn<SaveGeneratedComic>(async (input, context) => {
      expect(context.environment).toBe(liveDemo);
      expect(context.signal.aborted).toBe(false);
      expect(input.generation).toMatchObject({
        generationId,
        entryId: generation.entry_id,
        ownerId: generation.owner_id,
        entryRevision: generation.entry_revision,
        diaryDate: generation.diary_date,
        claimToken,
      });
      expect(input.profileId).toBe(openaiGenerationProfileId);
      expect(input.script).toEqual(script);
      expect(input.rendered.panels.map((panel) => panel.index)).toEqual([1, 2, 3, 4]);
      expect(input.providerCalls.script.callIndex).toBe(1);
      expect(input.providerCalls.images.map((call) => call.callIndex)).toEqual([1, 2, 3, 4]);
      return { generationId, status: 'succeeded' };
    });
    const message = queueMessage({ generationId });

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [message] },
      liveDemo,
      fetcher,
      {
        saveGeneratedComic,
        createScriptProvider: () => scriptProvider,
        createImageProvider: () => imageProvider,
      },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(saveGeneratedComic).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'mark_generation_saving',
    ]);
    expect(calls.filter((call) => call.name === 'begin_provider_attempt').map((call) => call.body)).toEqual([
      { p_generation_id: generationId, p_claim_token: claimToken, p_stage: 'script', p_call_index: 1, p_generation_enabled: true },
      ...[1, 2, 3, 4].map((callIndex) => ({
        p_generation_id: generationId,
        p_claim_token: claimToken,
        p_stage: 'images',
        p_call_index: callIndex,
        p_generation_enabled: true,
      })),
    ]);
  });

  it('does not claim or invoke a provider when OpenAI runtime prerequisites are missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const queue = { send: vi.fn(async () => undefined) };
    const enabled: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const provider = vi.fn();
    await expect(
      processGenerationMessage(enabled, generationId, fetcher, {
        createScriptProvider: () => ({ createScript: provider }),
      }),
    ).resolves.toBe('ignored');
    await expect(
      processGenerationMessage(
        { ...enabled, OPENAI_API_KEY: undefined },
        generationId,
        fetcher,
        { saveGeneratedComic: vi.fn() },
      ),
    ).resolves.toBe('ignored');
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('holds an unknown provider result and acknowledges duplicate delivery without replaying it', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const generation = openAIClaim();
    const attemptId = crypto.randomUUID();
    let claims = 0;
    const fetcher = rpcFetcher((name, body) => {
      if (name === 'claim_generation') return claims++ === 0 ? generation : null;
      if (name === 'begin_provider_attempt')
        return {
          attempt_id: attemptId,
          generation_id: generationId,
          stage: 'script',
          call_index: 1,
          mode: 'provider',
          is_mock: false,
        };
      if (name === 'finish_provider_attempt')
        return {
          attempt_id: attemptId,
          state: 'unknown',
          request_id: 'request-may-have-run',
          finished_at: new Date().toISOString(),
          is_mock: false,
        };
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: body.p_generation_id,
          status: 'unknown',
          reservation_state: 'held',
          released: false,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const createScriptProvider = vi.fn(() => ({
      createScript: async (_input: unknown, options: import('./ai/script-provider').CallOptions) => {
        const id = await options.attemptHooks!.begin('script', 1);
        await options.attemptHooks!.finish('script', 1, id, {
          state: 'unknown',
          requestId: 'request-may-have-run',
        });
        throw new Error('OPENAI_RESULT_UNKNOWN');
      },
    }));
    const saveGeneratedComic = vi.fn<SaveGeneratedComic>();
    const first = queueMessage({ generationId });
    const duplicate = queueMessage({ generationId });

    await consumeGenerationQueue(
      {
        queue: 'manga-nikki-generations-live-demo',
        messages: [first, duplicate],
      },
      liveDemo,
      fetcher,
      { saveGeneratedComic, createScriptProvider },
    );

    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(duplicate.retry).not.toHaveBeenCalled();
    expect(createScriptProvider).toHaveBeenCalledOnce();
    expect(saveGeneratedComic).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'fail_or_hold_generation',
      'claim_generation',
    ]);
    expect(calls[3]?.body).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_terminal_status: 'failed',
    });
  });

  it('acknowledges malformed messages and leaves unsupported modes inert', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const fetcher = rpcFetcher(() => {
      throw new Error('unexpected RPC');
    }, calls);
    const malformed = queueMessage({ generationId, diaryText: '日記本文を含めてはいけない' });
    const demoMessage = queueMessage({ generationId });
    const liveDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
    };

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [malformed, demoMessage] },
      liveDemo,
      fetcher,
    );

    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(demoMessage.ack).toHaveBeenCalledOnce();
    expect(malformed.retry).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('re-enqueues only queued work and reconciles cancelled or expired jobs without replaying them', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const queue = { send: vi.fn(async () => undefined) };
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates')
        return [
          { generation_id: generationId, action: 'enqueue' },
          { generation_id: '77777777-7777-4777-8777-777777777777', action: 'cancel' },
          { generation_id: '88888888-8888-4888-8888-888888888888', action: 'expire' },
        ];
      if (name === 'mark_generation_enqueued') return true;
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: calls.at(-1)?.body.p_generation_id,
          status: 'cancelled',
          reservation_state: 'released',
          released: true,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);

    await reconcileGenerationQueue(environment(queue), fetcher);

    expect(queue.send).toHaveBeenCalledExactlyOnceWith({ generationId });
    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates',
      'mark_generation_enqueued',
      'fail_or_hold_generation',
      'fail_or_hold_generation',
    ]);
    expect(calls[0]?.body).toEqual({ p_limit: 25 });
    expect(calls.slice(2).map((call) => call.body)).toEqual([
      {
        p_generation_id: '77777777-7777-4777-8777-777777777777',
        p_claim_token: null,
        p_terminal_status: 'failed',
      },
      {
        p_generation_id: '88888888-8888-4888-8888-888888888888',
        p_claim_token: null,
        p_terminal_status: 'failed',
      },
    ]);
  });

  it('continues settling later candidates when an earlier enqueue fails, then rejects the cron run', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const cancelledId = '77777777-7777-4777-8777-777777777777';
    const queue = {
      send: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    };
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates')
        return [
          { generation_id: generationId, action: 'enqueue' },
          { generation_id: cancelledId, action: 'cancel' },
        ];
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: cancelledId,
          status: 'cancelled',
          reservation_state: 'released',
          released: true,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);

    await expect(reconcileGenerationQueue(environment(queue), fetcher)).rejects.toThrow(
      'GENERATION_RECONCILE_FAILED',
    );

    expect(queue.send).toHaveBeenCalledExactlyOnceWith({ generationId });
    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates',
      'fail_or_hold_generation',
    ]);
    expect(calls[1]?.body).toEqual({
      p_generation_id: cancelledId,
      p_claim_token: null,
      p_terminal_status: 'failed',
    });
  });

  it('settles live-demo cancellation and expiry candidates while stopped and without a Queue', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const disabledDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      OPENAI_API_KEY: undefined,
      GENERATION_QUEUE: undefined,
    };
    const cancelledId = '77777777-7777-4777-8777-777777777777';
    const expiredId = '88888888-8888-4888-8888-888888888888';
    const fetcher = rpcFetcher((name, body) => {
      if (name === 'list_generation_reconcile_candidates')
        return [
          { generation_id: generationId, action: 'enqueue' },
          { generation_id: cancelledId, action: 'cancel' },
          { generation_id: expiredId, action: 'expire' },
        ];
      if (name === 'fail_or_hold_generation')
        return {
          generation_id: body.p_generation_id,
          status: 'cancelled',
          reservation_state: 'released',
          released: true,
        };
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);

    await reconcileGenerationQueue(disabledDemo, fetcher);

    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates',
      'fail_or_hold_generation',
      'fail_or_hold_generation',
    ]);
    expect(calls.slice(1).map((call) => call.body.p_generation_id)).toEqual([
      cancelledId,
      expiredId,
    ]);
  });

  it('retries queue delivery if an RPC dependency fails before claiming', async () => {
    const message = queueMessage({ generationId });
    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-local-connected', messages: [message] },
      environment(),
      async () => new Response('unavailable', { status: 503 }),
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
