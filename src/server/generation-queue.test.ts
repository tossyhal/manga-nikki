import { describe, expect, it, vi } from 'vitest';
import scriptSample from '../../docs/contracts/script.example.json';
import { openaiGenerationProfileId } from './ai/openai-generation-profile';
import { openaiImageModelProfile } from './ai/openai-image-provider';
import { openaiScriptModelProfile } from './ai/openai-script-provider';
import type { ProviderCallMetadata, ProviderStage } from './ai/provider-attempts';
import type { ImageProvider, RenderedComic, RenderedPanel } from './ai/image-provider';
import type { RecoverGeneratedComic, SaveGeneratedComic } from './generation-save-handler';
import type { ScriptProvider } from './ai/script-provider';
import { scriptSchema } from './ai/script-schema';
import {
  consumeGenerationQueue,
  processGenerationMessage,
  reconcileGenerationQueue,
} from './generation-queue';
import { mockEnvironment, type Environment } from './mode';
import { runOpenAIGeneration } from './openai-generation-runner';

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

function rpcFetcherForOpenAI(
  generation: ReturnType<typeof openAIClaim>,
  calls: { name: string; body: Record<string, unknown> }[],
) {
  return rpcFetcher((name, body) => {
    if (name === 'parallel_image_generation_ready') return true;
    if (name === 'global_image_pacing_ready') return true;
    if (name === 'claim_generation') return generation;
    if (name === 'begin_provider_attempt')
      return {
        attempt_id: crypto.randomUUID(),
        generation_id: generationId,
        stage: body.p_stage,
        call_index: body.p_call_index,
        mode: 'provider',
        is_mock: false,
      };
    if (name === 'begin_paced_image_attempts')
      return {
        status: 'ready',
        attempts: (body.p_call_indices as number[]).map((callIndex) => ({
          attempt_id: crypto.randomUUID(),
          generation_id: generation.generation_id,
          stage: 'images',
          call_index: callIndex,
          mode: 'provider',
          is_mock: false,
        })),
      };
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
    if (name === 'fail_or_hold_generation')
      return {
        generation_id: generationId,
        status: 'failed',
        reservation_state: 'consumed',
        released: false,
      };
    throw new Error(`unexpected RPC: ${name}`);
  }, calls);
}

function successfulOpenAIProviders(parallelImages = true) {
  const script = scriptSchema.parse(structuredClone(scriptSample));
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  );
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
      const firstAttemptId = await options.attemptHooks!.begin('images', 1);
      const firstMetadata = metadataFor('images', 1, openaiImageModelProfile.modelId);
      await options.attemptHooks!.finish('images', 1, firstAttemptId, {
        state: 'succeeded',
        requestId: firstMetadata.requestId,
        metadata: firstMetadata,
      });
      panels.push({ index: 1, mediaType: 'image/png', data: png });

      const finishPanel = async (callIndex: number, attemptId: string) => {
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
      };
      if (parallelImages) {
        const attempts = await options.attemptHooks!.beginBatch!('images', [2, 3, 4]);
        for (const { callIndex, attemptId } of attempts) await finishPanel(callIndex, attemptId);
      } else {
        for (const callIndex of [2, 3, 4]) {
          const attemptId = await options.attemptHooks!.begin('images', callIndex);
          await finishPanel(callIndex, attemptId);
        }
      }
      return {
        kind: 'panels' as const,
        textMode: 'external' as const,
        modelId: openaiImageModelProfile.modelId,
        panels: panels as RenderedComic['panels'],
      };
    },
  };
  return { script, scriptProvider, imageProvider };
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
    const providers = successfulOpenAIProviders();
    const fetcher = rpcFetcher((name, body) => {
      if (name === 'parallel_image_generation_ready') return true;
      if (name === 'global_image_pacing_ready') return true;
      if (name === 'claim_generation') return generation;
      if (name === 'begin_provider_attempt')
        return {
          attempt_id: crypto.randomUUID(),
          generation_id: generationId,
          stage: body.p_stage,
          call_index: body.p_call_index,
          mode: 'provider',
          is_mock: false,
        };
      if (name === 'begin_paced_image_attempts')
        return {
          status: 'ready',
          attempts: (body.p_call_indices as number[]).map((callIndex) => ({
            attempt_id: crypto.randomUUID(),
            generation_id: generationId,
            stage: 'images',
            call_index: callIndex,
            mode: 'provider',
            is_mock: false,
          })),
        };
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
      expect(input.script).toEqual(providers.script);
      expect(input.rendered.panels.map((panel) => panel.index)).toEqual([1, 2, 3, 4]);
      expect(input.providerCalls.script.callIndex).toBe(1);
      expect(input.providerCalls.images.map((call) => call.callIndex)).toEqual([1, 2, 3, 4]);
      return { generationId, status: 'succeeded' };
    });
    const recoverGeneratedComic: RecoverGeneratedComic = async (requestedId) => ({
      generationId: requestedId,
      status: 'pending',
    });
    const message = queueMessage({ generationId });

    await consumeGenerationQueue(
      { queue: 'manga-nikki-generations-live-demo', messages: [message] },
      liveDemo,
      fetcher,
      {
        saveGeneratedComic,
        recoverGeneratedComic,
        createScriptProvider: () => providers.scriptProvider,
        createImageProvider: () => providers.imageProvider,
      },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(saveGeneratedComic).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'global_image_pacing_ready',
      'parallel_image_generation_ready',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'begin_paced_image_attempts',
      'finish_provider_attempt',
      'begin_paced_image_attempts',
      'finish_provider_attempt',
      'finish_provider_attempt',
      'finish_provider_attempt',
      'mark_generation_saving',
    ]);
    expect(
      calls.filter((call) => call.name === 'begin_provider_attempt').map((call) => call.body),
    ).toEqual([
      {
        p_generation_id: generationId,
        p_claim_token: claimToken,
        p_stage: 'script',
        p_call_index: 1,
        p_generation_enabled: true,
      },
    ]);
    expect(
      calls.find(
        (call) =>
          call.name === 'begin_paced_image_attempts' &&
          JSON.stringify(call.body.p_call_indices) === JSON.stringify([2, 3, 4]),
      )?.body,
    ).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_call_indices: [2, 3, 4],
      p_generation_enabled: true,
    });
  });

  it('falls back to serial image attempts when the database has not applied the batch migration', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const generation = openAIClaim();
    const providers = successfulOpenAIProviders(false);
    const rpcFetcher = rpcFetcherForOpenAI(generation, calls);
    let readinessCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (requestUrl.endsWith('/rpc/parallel_image_generation_ready')) {
        readinessCalls += 1;
        return Response.json(
          { code: 'PGRST202', message: 'function was not present in the schema cache' },
          { status: 404 },
        );
      }
      return rpcFetcher(input, init);
    };
    const saveGeneratedComic = vi.fn<SaveGeneratedComic>(async () => ({
      generationId,
      status: 'succeeded',
    }));

    const outcome = await processGenerationMessage(liveDemo, generationId, fetcher, {
      saveGeneratedComic,
      recoverGeneratedComic: async (requestedId) => ({
        generationId: requestedId,
        status: 'pending',
      }),
      createScriptProvider: () => providers.scriptProvider,
      createImageProvider: () => providers.imageProvider,
    });

    expect(outcome).toBe('handed-off');
    expect(readinessCalls).toBe(1);
    expect(calls.filter((call) => call.name === 'begin_provider_attempt')).toHaveLength(1);
    expect(calls.filter((call) => call.name === 'begin_paced_image_attempts')).toHaveLength(4);
    expect(
      calls
        .filter((call) => call.name === 'begin_paced_image_attempts')
        .map((call) => call.body.p_call_indices),
    ).toEqual([[1], [2], [3], [4]]);
    expect(calls.some((call) => call.name === 'begin_parallel_image_attempts')).toBe(false);
    expect(saveGeneratedComic).toHaveBeenCalledOnce();
  });

  it('stops before an AI attempt when readiness fails for a reason other than a missing function', async () => {
    const liveDemo: Environment = {
      ...environment({ send: vi.fn(async () => undefined) }),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ code: 'PGRST000', message: 'temporary database error' }, { status: 500 }),
    );
    const createScriptProvider = vi.fn();
    const createImageProvider = vi.fn();

    await expect(
      runOpenAIGeneration(liveDemo, fetcher, openAIClaim(), {
        saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
        recoverGeneratedComic: vi.fn<RecoverGeneratedComic>(),
        createScriptProvider,
        createImageProvider,
      }),
    ).rejects.toThrow('IMAGE_PACING_READINESS_FAILED');

    expect(fetcher).toHaveBeenCalledOnce();
    expect(createScriptProvider).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
  });

  it.each(['false', 'missing RPC', 'database error'] as const)(
    'fails closed before the script provider when global image pacing is %s',
    async (failureMode) => {
      const liveDemo: Environment = {
        ...environment(),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      const calls: string[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const name = new URL(request.url).pathname.split('/').at(-1) ?? '';
        calls.push(name);
        if (name === 'parallel_image_generation_ready') return Response.json(true);
        if (name === 'global_image_pacing_ready') {
          if (failureMode === 'false') return Response.json(false);
          if (failureMode === 'missing RPC')
            return Response.json(
              { code: 'PGRST202', message: 'function missing' },
              { status: 404 },
            );
          return Response.json({ code: 'PGRST000', message: 'database error' }, { status: 500 });
        }
        throw new Error(`unexpected RPC: ${name}`);
      };
      const createScriptProvider = vi.fn();
      const createImageProvider = vi.fn();

      await expect(
        runOpenAIGeneration(liveDemo, fetcher, openAIClaim(), {
          saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
          recoverGeneratedComic: vi.fn<RecoverGeneratedComic>(),
          createScriptProvider,
          createImageProvider,
        }),
      ).rejects.toBeDefined();

      expect(calls).toEqual(['global_image_pacing_ready']);
      expect(createScriptProvider).not.toHaveBeenCalled();
      expect(createImageProvider).not.toHaveBeenCalled();
    },
  );

  it('releases a claimed generation when readiness fails before any provider attempt', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const generation = openAIClaim();
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const failureResult = {
      generation_id: generationId,
      status: 'failed',
      reservation_state: 'released',
      released: true,
    };
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const name = new URL(request.url).pathname.split('/').at(-1) ?? '';
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ name, body });
      if (name === 'claim_generation') return Response.json(generation);
      if (name === 'parallel_image_generation_ready')
        return Response.json(
          { code: 'PGRST000', message: 'temporary database error' },
          { status: 500 },
        );
      if (name === 'fail_or_hold_generation') return Response.json(failureResult);
      throw new Error(`unexpected RPC: ${name}`);
    };
    const createScriptProvider = vi.fn();
    const createImageProvider = vi.fn();

    await expect(
      processGenerationMessage(liveDemo, generationId, fetcher, {
        saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
        recoverGeneratedComic: vi.fn<RecoverGeneratedComic>(),
        createScriptProvider,
        createImageProvider,
      }),
    ).resolves.toBe('failed');

    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'global_image_pacing_ready',
      'fail_or_hold_generation',
    ]);
    expect(calls[2]?.body).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_terminal_status: 'failed',
    });
    expect(failureResult).toMatchObject({ status: 'failed', reservation_state: 'released' });
    expect(createScriptProvider).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
  });

  it.each([0, 408, 429, 503])(
    'retries one transient saving transition failure (status %i) without replaying provider attempts',
    async (transientStatus) => {
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const queue = { send: vi.fn(async () => undefined) };
      const liveDemo: Environment = {
        ...environment(queue),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      const generation = openAIClaim();
      const providers = successfulOpenAIProviders();
      const rpcFetcher = rpcFetcherForOpenAI(generation, calls);
      let markCalls = 0;
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith('/mark_generation_saving')) {
          markCalls++;
          expect(request.signal.aborted).toBe(false);
          if (markCalls === 1) {
            if (transientStatus === 0) throw new TypeError('temporary transport failure');
            return Response.json(
              { code: 'PGRST000', message: 'temporary dependency failure' },
              { status: transientStatus },
            );
          }
        }
        return rpcFetcher(input, init);
      };
      const saveGeneratedComic = vi.fn<SaveGeneratedComic>(async () => ({
        generationId,
        status: 'succeeded',
      }));

      const outcome = await processGenerationMessage(liveDemo, generationId, fetcher, {
        saveGeneratedComic,
        recoverGeneratedComic: async (requestedId) => ({
          generationId: requestedId,
          status: 'pending',
        }),
        createScriptProvider: () => providers.scriptProvider,
        createImageProvider: () => providers.imageProvider,
      });

      expect(outcome).toBe('handed-off');
      expect(markCalls).toBe(2);
      expect(calls.filter((call) => call.name === 'begin_provider_attempt')).toHaveLength(1);
      expect(calls.filter((call) => call.name === 'begin_paced_image_attempts')).toHaveLength(2);
      expect(calls.filter((call) => call.name === 'finish_provider_attempt')).toHaveLength(5);
      expect(calls.filter((call) => call.name === 'mark_generation_saving')).toHaveLength(1);
      expect(calls.some((call) => call.name === 'fail_or_hold_generation')).toBe(false);
      expect(saveGeneratedComic).toHaveBeenCalledOnce();
    },
  );

  it('does not retry a permanent saving transition rejection', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const generation = openAIClaim();
    const providers = successfulOpenAIProviders();
    const rpcFetcher = rpcFetcherForOpenAI(generation, calls);
    let markCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/mark_generation_saving')) {
        markCalls++;
        return Response.json({ code: 'P0001', message: 'CLAIM_EXPIRED' }, { status: 400 });
      }
      return rpcFetcher(input, init);
    };
    const saveGeneratedComic = vi.fn<SaveGeneratedComic>();

    const outcome = await processGenerationMessage(liveDemo, generationId, fetcher, {
      saveGeneratedComic,
      recoverGeneratedComic: async (requestedId) => ({
        generationId: requestedId,
        status: 'pending',
      }),
      createScriptProvider: () => providers.scriptProvider,
      createImageProvider: () => providers.imageProvider,
    });

    expect(outcome).toBe('failed');
    expect(markCalls).toBe(1);
    expect(calls.filter((call) => call.name === 'begin_provider_attempt')).toHaveLength(1);
    expect(calls.filter((call) => call.name === 'begin_paced_image_attempts')).toHaveLength(2);
    expect(calls.filter((call) => call.name === 'finish_provider_attempt')).toHaveLength(5);
    expect(calls.filter((call) => call.name === 'fail_or_hold_generation')).toHaveLength(1);
    expect(saveGeneratedComic).not.toHaveBeenCalled();
  });

  it('aborts the saving transition and skips its retry after the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00.000Z'));
    try {
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const queue = { send: vi.fn(async () => undefined) };
      const liveDemo: Environment = {
        ...environment(queue),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      const generation = openAIClaim();
      const providers = successfulOpenAIProviders();
      const rpcFetcher = rpcFetcherForOpenAI(generation, calls);
      let markCalls = 0;
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith('/mark_generation_saving')) {
          markCalls++;
          expect(request.signal.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(14 * 60_000 + 1);
          expect(request.signal.aborted).toBe(true);
          return Response.json(
            { code: 'PGRST000', message: 'temporary dependency failure' },
            { status: 503 },
          );
        }
        return rpcFetcher(input, init);
      };
      const saveGeneratedComic = vi.fn<SaveGeneratedComic>();

      await expect(
        runOpenAIGeneration(liveDemo, fetcher, generation, {
          saveGeneratedComic,
          recoverGeneratedComic: async (requestedId) => ({
            generationId: requestedId,
            status: 'pending',
          }),
          createScriptProvider: () => providers.scriptProvider,
          createImageProvider: () => providers.imageProvider,
        }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });

      expect(markCalls).toBe(1);
      expect(calls.filter((call) => call.name === 'begin_provider_attempt')).toHaveLength(1);
      expect(calls.filter((call) => call.name === 'begin_paced_image_attempts')).toHaveLength(2);
      expect(saveGeneratedComic).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a known provider outcome after the generation deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00.000Z'));
    try {
      const generation = openAIClaim();
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const liveDemo: Environment = {
        ...environment(),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      const fetcher = rpcFetcher((name, body) => {
        if (name === 'global_image_pacing_ready') return true;
        if (name === 'parallel_image_generation_ready') return true;
        if (name === 'begin_provider_attempt')
          return {
            attempt_id: '55555555-5555-4555-8555-555555555555',
            generation_id: generationId,
            stage: 'script',
            call_index: 1,
            mode: 'provider',
            is_mock: false,
          };
        if (name === 'finish_provider_attempt')
          return {
            attempt_id: body.p_attempt_id,
            state: body.p_state,
            request_id: body.p_request_id,
            finished_at: new Date().toISOString(),
            is_mock: false,
          };
        throw new Error(`unexpected RPC: ${name}`);
      }, calls);
      const createScriptProvider = () => ({
        createScript: async (
          _input: unknown,
          options: import('./ai/script-provider').CallOptions,
        ) => {
          const attemptId = await options.attemptHooks!.begin('script', 1);
          await vi.advanceTimersByTimeAsync(14 * 60_000 + 1);
          expect(options.signal.aborted).toBe(true);
          await options.attemptHooks!.finish('script', 1, attemptId, {
            state: 'succeeded',
            requestId: 'known-script-request',
            metadata: {
              stage: 'script',
              callIndex: 1,
              modelId: openaiScriptModelProfile.modelId,
              requestId: 'known-script-request',
            },
          });
          throw new DOMException('Generation deadline exceeded', 'TimeoutError');
        },
      });

      await expect(
        runOpenAIGeneration(liveDemo, fetcher, generation, {
          saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
          recoverGeneratedComic: vi.fn<RecoverGeneratedComic>(),
          createScriptProvider,
        }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });

      expect(calls.map((call) => call.name)).toEqual([
        'global_image_pacing_ready',
        'parallel_image_generation_ready',
        'begin_provider_attempt',
        'finish_provider_attempt',
      ]);
      expect(calls.at(-1)?.body).toMatchObject({
        p_attempt_id: '55555555-5555-4555-8555-555555555555',
        p_state: 'succeeded',
        p_request_id: 'known-script-request',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards direct OpenAI runner calls when recovery is not configured', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const liveDemo: Environment = {
      ...environment(queue),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
    };
    const fetcher = vi.fn<typeof fetch>();
    const createScriptProvider = vi.fn();
    const createImageProvider = vi.fn();

    await expect(
      runOpenAIGeneration(liveDemo, fetcher, openAIClaim(), {
        saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
        createScriptProvider,
        createImageProvider,
      }),
    ).rejects.toThrow('OPENAI_GENERATION_DISABLED');

    expect(fetcher).not.toHaveBeenCalled();
    expect(createScriptProvider).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
  });

  it('rejects another owner in a claimed job before invoking providers or attempt RPCs', async () => {
    const liveDemo: Environment = {
      ...environment(),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'provider-key-for-test-only',
      GENERATION_ALLOWED_OWNER_ID: 'aaaaaaaa-1111-4111-8111-111111111111',
    };
    const fetcher = vi.fn<typeof fetch>();
    const createScriptProvider = vi.fn();
    const createImageProvider = vi.fn();
    await expect(
      runOpenAIGeneration(liveDemo, fetcher, openAIClaim(), {
        saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
        recoverGeneratedComic: vi.fn<RecoverGeneratedComic>(),
        createScriptProvider,
        createImageProvider,
      }),
    ).rejects.toThrow('OPENAI_GENERATION_DISABLED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(createScriptProvider).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
  });

  it.each(['throws', 'returns another generation'] as const)(
    'keeps a saving generation pending when the saver %s after saving starts',
    async (saveOutcome) => {
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const queue = { send: vi.fn(async () => undefined) };
      const liveDemo: Environment = {
        ...environment(queue),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      const generation = openAIClaim();
      const providers = successfulOpenAIProviders();
      let stage: 'running' | 'saving' = 'running';
      const fetcher = rpcFetcher((name, body) => {
        if (name === 'parallel_image_generation_ready') return true;
        if (name === 'global_image_pacing_ready') return true;
        if (name === 'claim_generation') return generation;
        if (name === 'begin_provider_attempt')
          return {
            attempt_id: crypto.randomUUID(),
            generation_id: generationId,
            stage: body.p_stage,
            call_index: body.p_call_index,
            mode: 'provider',
            is_mock: false,
          };
        if (name === 'begin_paced_image_attempts')
          return {
            status: 'ready',
            attempts: (body.p_call_indices as number[]).map((callIndex) => ({
              attempt_id: crypto.randomUUID(),
              generation_id: generationId,
              stage: 'images',
              call_index: callIndex,
              mode: 'provider',
              is_mock: false,
            })),
          };
        if (name === 'finish_provider_attempt')
          return {
            attempt_id: body.p_attempt_id,
            state: body.p_state,
            request_id: body.p_request_id,
            finished_at: new Date().toISOString(),
            is_mock: false,
          };
        if (name === 'mark_generation_saving') {
          stage = 'saving';
          return { generation_id: generationId, status: 'running', stage: 'saving' };
        }
        if (name === 'list_generation_reconcile_candidates_v2')
          return stage === 'saving'
            ? [{ generation_id: generationId, action: 'recover-saving' }]
            : [];
        if (name === 'begin_generation_save_recovery') return true;
        throw new Error(`unexpected rpc: ${name}`);
      }, calls);
      const saveGeneratedComic = vi.fn<SaveGeneratedComic>(async () => {
        if (saveOutcome === 'throws') throw new Error('temporary completion database outage');
        return { generationId: '99999999-9999-4999-8999-999999999999', status: 'succeeded' };
      });
      const recoverGeneratedComic = vi.fn<RecoverGeneratedComic>(async (requestedId) => {
        expect(calls.at(-1)?.name).toBe('begin_generation_save_recovery');
        return { generationId: requestedId, status: 'pending' };
      });
      const createScriptProvider = vi.fn((_apiKey: string) => providers.scriptProvider);
      const createImageProvider = vi.fn((_apiKey: string) => providers.imageProvider);
      const message = queueMessage({ generationId });

      await consumeGenerationQueue(
        { queue: 'manga-nikki-generations-live-demo', messages: [message] },
        liveDemo,
        fetcher,
        {
          saveGeneratedComic,
          recoverGeneratedComic,
          createScriptProvider,
          createImageProvider,
        },
      );

      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(saveGeneratedComic).toHaveBeenCalledOnce();
      expect(calls.some((call) => call.name === 'fail_or_hold_generation')).toBe(false);
      const scriptFactoryCalls = createScriptProvider.mock.calls.length;
      const imageFactoryCalls = createImageProvider.mock.calls.length;
      await reconcileGenerationQueue(liveDemo, fetcher, {
        recoverGeneratedComic,
        createScriptProvider,
        createImageProvider,
      });
      expect(recoverGeneratedComic).toHaveBeenCalledOnce();
      expect(createScriptProvider).toHaveBeenCalledTimes(scriptFactoryCalls);
      expect(createImageProvider).toHaveBeenCalledTimes(imageFactoryCalls);
      expect(calls.map((call) => call.name)).toEqual([
        'claim_generation',
        'global_image_pacing_ready',
        'parallel_image_generation_ready',
        'begin_provider_attempt',
        'finish_provider_attempt',
        'begin_paced_image_attempts',
        'finish_provider_attempt',
        'begin_paced_image_attempts',
        'finish_provider_attempt',
        'finish_provider_attempt',
        'finish_provider_attempt',
        'mark_generation_saving',
        'list_generation_reconcile_candidates_v2',
        'begin_generation_save_recovery',
      ]);
    },
  );

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
    const recoveryHandler: RecoverGeneratedComic = async (requestedId) => ({
      generationId: requestedId,
      status: 'pending',
    });
    await expect(
      processGenerationMessage({ ...enabled, OPENAI_API_KEY: undefined }, generationId, fetcher, {
        saveGeneratedComic: vi.fn(),
        recoverGeneratedComic: recoveryHandler,
      }),
    ).resolves.toBe('ignored');
    await expect(
      processGenerationMessage(enabled, generationId, fetcher, {
        saveGeneratedComic: vi.fn(),
      }),
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
      if (name === 'parallel_image_generation_ready') return true;
      if (name === 'global_image_pacing_ready') return true;
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
      createScript: async (
        _input: unknown,
        options: import('./ai/script-provider').CallOptions,
      ) => {
        const id = await options.attemptHooks!.begin('script', 1);
        await options.attemptHooks!.finish('script', 1, id, {
          state: 'unknown',
          requestId: 'request-may-have-run',
        });
        throw new Error('OPENAI_RESULT_UNKNOWN');
      },
    }));
    const saveGeneratedComic = vi.fn<SaveGeneratedComic>();
    const recoverGeneratedComic: RecoverGeneratedComic = async (requestedId) => ({
      generationId: requestedId,
      status: 'pending',
    });
    const first = queueMessage({ generationId });
    const duplicate = queueMessage({ generationId });

    await consumeGenerationQueue(
      {
        queue: 'manga-nikki-generations-live-demo',
        messages: [first, duplicate],
      },
      liveDemo,
      fetcher,
      { saveGeneratedComic, recoverGeneratedComic, createScriptProvider },
    );

    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(duplicate.retry).not.toHaveBeenCalled();
    expect(createScriptProvider).toHaveBeenCalledOnce();
    expect(saveGeneratedComic).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      'claim_generation',
      'global_image_pacing_ready',
      'parallel_image_generation_ready',
      'begin_provider_attempt',
      'finish_provider_attempt',
      'fail_or_hold_generation',
      'claim_generation',
    ]);
    expect(calls[5]?.body).toEqual({
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
      if (name === 'list_generation_reconcile_candidates_v2')
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
      'list_generation_reconcile_candidates_v2',
      'fail_or_hold_generation',
      'fail_or_hold_generation',
      'mark_generation_enqueued',
    ]);
    expect(calls[0]?.body).toEqual({ p_limit: 25 });
    expect(
      calls.filter((call) => call.name === 'fail_or_hold_generation').map((call) => call.body),
    ).toEqual([
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
      if (name === 'list_generation_reconcile_candidates_v2')
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
      'list_generation_reconcile_candidates_v2',
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
      if (name === 'list_generation_reconcile_candidates_v2')
        return [
          { generation_id: generationId, action: 'enqueue' },
          { generation_id: '99999999-9999-4999-8999-999999999999', action: 'recover-saving' },
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
      'list_generation_reconcile_candidates_v2',
      'fail_or_hold_generation',
      'fail_or_hold_generation',
    ]);
    expect(calls.slice(1).map((call) => call.body.p_generation_id)).toEqual([
      cancelledId,
      expiredId,
    ]);
  });

  it('recovers saving candidates without OpenAI readiness or Queue dispatch', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const disabledDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      OPENAI_API_KEY: undefined,
      GENERATION_QUEUE: undefined,
    };
    const recoveryId = '99999999-9999-4999-8999-999999999999';
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates_v2')
        return [{ generation_id: recoveryId, action: 'recover-saving' }];
      if (name === 'begin_generation_save_recovery') return true;
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const recoverGeneratedComic = vi.fn<RecoverGeneratedComic>(async (requestedId, context) => {
      expect(context.environment).toBe(disabledDemo);
      expect(context.signal.aborted).toBe(false);
      return { generationId: requestedId, status: 'succeeded' };
    });
    const createScriptProvider = vi.fn();
    const createImageProvider = vi.fn();

    await reconcileGenerationQueue(disabledDemo, fetcher, {
      recoverGeneratedComic,
      createScriptProvider,
      createImageProvider,
    });

    expect(recoverGeneratedComic).toHaveBeenCalledOnce();
    expect(recoverGeneratedComic).toHaveBeenCalledWith(recoveryId, expect.any(Object));
    expect(createScriptProvider).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates_v2',
      'begin_generation_save_recovery',
    ]);
  });

  it('skips saving recovery when another worker holds the recovery lease', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const stoppedDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      OPENAI_API_KEY: undefined,
      GENERATION_QUEUE: undefined,
    };
    const recoverGeneratedComic = vi.fn<RecoverGeneratedComic>();
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates_v2')
        return [{ generation_id: generationId, action: 'recover-saving' }];
      if (name === 'begin_generation_save_recovery') return false;
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);

    await reconcileGenerationQueue(stoppedDemo, fetcher, { recoverGeneratedComic });

    expect(recoverGeneratedComic).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates_v2',
      'begin_generation_save_recovery',
    ]);
  });

  it('orders settlement and enqueue before recovery, times out hung recovery, and runs at most three', async () => {
    vi.useFakeTimers();
    try {
      const calls: { name: string; body: Record<string, unknown> }[] = [];
      const events: string[] = [];
      const firstRecoveryId = generationId;
      const secondRecoveryId = '77777777-7777-4777-8777-777777777777';
      const thirdRecoveryId = '88888888-8888-4888-8888-888888888888';
      const fourthRecoveryId = '99999999-9999-4999-8999-999999999999';
      const enqueueId = '55555555-5555-4555-8555-555555555555';
      const cancelledId = '66666666-6666-4666-8666-666666666666';
      const queue = {
        send: vi.fn(async () => {
          events.push('enqueue');
          return undefined;
        }),
      };
      const liveDemo: Environment = {
        ...environment(queue),
        AI_MODE: 'live',
        GENERATION_ENABLED: 'true',
        OPENAI_API_KEY: 'provider-key-for-test-only',
      };
      let recoveryStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        recoveryStarted = resolve;
      });
      let firstSignal: AbortSignal | undefined;
      const recoverGeneratedComic = vi.fn<RecoverGeneratedComic>(async (requestedId, context) => {
        events.push(`recover:${requestedId}`);
        if (requestedId === firstRecoveryId) {
          firstSignal = context.signal;
          recoveryStarted();
          return new Promise<Awaited<ReturnType<RecoverGeneratedComic>>>(() => {});
        }
        return { generationId: requestedId, status: 'pending' };
      });
      const fetcher = rpcFetcher((name, body) => {
        if (name === 'list_generation_reconcile_candidates_v2') {
          events.push('list');
          return [
            { generation_id: firstRecoveryId, action: 'recover-saving' },
            { generation_id: secondRecoveryId, action: 'recover-saving' },
            { generation_id: thirdRecoveryId, action: 'recover-saving' },
            { generation_id: fourthRecoveryId, action: 'recover-saving' },
            { generation_id: enqueueId, action: 'enqueue' },
            { generation_id: cancelledId, action: 'cancel' },
          ];
        }
        if (name === 'begin_generation_save_recovery') {
          events.push(`lease:${String(body.p_generation_id)}`);
          return true;
        }
        if (name === 'fail_or_hold_generation') {
          events.push(`cancel:${String(body.p_generation_id)}`);
          return { generation_id: body.p_generation_id, status: 'cancelled' };
        }
        if (name === 'mark_generation_enqueued') {
          events.push(`marked:${String(body.p_generation_id)}`);
          return true;
        }
        throw new Error(`unexpected rpc: ${name}`);
      }, calls);
      const reconciliation = reconcileGenerationQueue(liveDemo, fetcher, {
        saveGeneratedComic: vi.fn<SaveGeneratedComic>(),
        recoverGeneratedComic,
      });
      const reconciliationExpectation = expect(reconciliation).rejects.toThrow(
        'GENERATION_RECONCILE_FAILED',
      );

      await started;
      await vi.advanceTimersByTimeAsync(120_000);
      await reconciliationExpectation;

      expect(firstSignal?.aborted).toBe(true);
      expect(recoverGeneratedComic).toHaveBeenCalledTimes(3);
      expect(calls.filter((call) => call.name === 'begin_generation_save_recovery')).toHaveLength(
        3,
      );
      expect(queue.send).toHaveBeenCalledOnce();
      expect(events).toEqual([
        'list',
        `cancel:${cancelledId}`,
        'enqueue',
        `marked:${enqueueId}`,
        `lease:${firstRecoveryId}`,
        `recover:${firstRecoveryId}`,
        `lease:${secondRecoveryId}`,
        `recover:${secondRecoveryId}`,
        `lease:${thirdRecoveryId}`,
        `recover:${thirdRecoveryId}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues after a recovery callback throws while retaining the retry marker', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const secondRecoveryId = '77777777-7777-4777-8777-777777777777';
    const stoppedDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      OPENAI_API_KEY: undefined,
      GENERATION_QUEUE: undefined,
    };
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates_v2')
        return [
          { generation_id: generationId, action: 'recover-saving' },
          { generation_id: secondRecoveryId, action: 'recover-saving' },
        ];
      if (name === 'begin_generation_save_recovery') return true;
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const recoverGeneratedComic = vi.fn<RecoverGeneratedComic>(async (requestedId) => {
      if (requestedId === generationId) throw new Error('temporary storage outage');
      return { generationId: requestedId, status: 'pending' };
    });

    await expect(
      reconcileGenerationQueue(stoppedDemo, fetcher, { recoverGeneratedComic }),
    ).rejects.toThrow('GENERATION_RECONCILE_FAILED');

    expect(recoverGeneratedComic).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates_v2',
      'begin_generation_save_recovery',
      'begin_generation_save_recovery',
    ]);
  });

  it('rejects a recovery result for another generation without settling the candidate', async () => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const stoppedDemo: Environment = {
      ...environment(),
      APP_ENV: 'production',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      OPENAI_API_KEY: undefined,
      GENERATION_QUEUE: undefined,
    };
    const fetcher = rpcFetcher((name) => {
      if (name === 'list_generation_reconcile_candidates_v2')
        return [{ generation_id: generationId, action: 'recover-saving' }];
      if (name === 'begin_generation_save_recovery') return true;
      throw new Error(`unexpected rpc: ${name}`);
    }, calls);
    const recoverGeneratedComic: RecoverGeneratedComic = async () => ({
      generationId: '99999999-9999-4999-8999-999999999999',
      status: 'succeeded',
    });

    await expect(
      reconcileGenerationQueue(stoppedDemo, fetcher, { recoverGeneratedComic }),
    ).rejects.toThrow('GENERATION_RECONCILE_FAILED');

    expect(calls.map((call) => call.name)).toEqual([
      'list_generation_reconcile_candidates_v2',
      'begin_generation_save_recovery',
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
