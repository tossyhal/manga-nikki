import { describe, expect, it, vi } from 'vitest';
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
    is_mock: isMock,
    input_snapshot: inputSnapshot,
    model_profile_snapshot: {
      profile_id: 'fixed-test-v1',
      is_mock: isMock,
      max_cost_micro_usd: 0,
      max_image_calls: 1,
    },
    claim_token: claimToken,
    deadline_at: '2026-11-04T00:15:00+00:00',
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
