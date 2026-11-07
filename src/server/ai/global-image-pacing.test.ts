import { describe, expect, it, vi } from 'vitest';
import { beginPacedImageAttempts } from './global-image-pacing';

const generationId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';

function attempts(callIndices: readonly number[], id = generationId) {
  return callIndices.map((callIndex) => ({
    attempt_id: crypto.randomUUID(),
    generation_id: id,
    stage: 'images',
    call_index: callIndex,
    mode: 'provider',
    is_mock: false,
  }));
}

function input(
  begin: (args: {
    p_generation_id: string;
    p_claim_token: string;
    p_call_indices: number[];
    p_generation_enabled: true;
  }) => Promise<unknown>,
  overrides: Partial<Parameters<typeof beginPacedImageAttempts>[0]> = {},
) {
  return {
    generationId,
    claimToken,
    callIndices: [1],
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60_000,
    begin,
    ...overrides,
  };
}

describe('global image pacing helper', () => {
  it('polls only valid waiting responses and validates the ready attempt', async () => {
    const begin = vi
      .fn<Parameters<typeof beginPacedImageAttempts>[0]['begin']>()
      .mockResolvedValueOnce({ status: 'waiting', wait_ms: 400 })
      .mockResolvedValueOnce({ status: 'ready', attempts: attempts([1]) });
    const sleep = vi.fn(async () => undefined);
    const result = await beginPacedImageAttempts(
      input(begin, { random: () => 0.5, sleep, deadlineMs: Date.now() + 10_000 }),
    );

    expect(begin).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenNthCalledWith(1, {
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_call_indices: [1],
      p_generation_enabled: true,
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(912, expect.any(AbortSignal));
    expect(result).toMatchObject([{ generation_id: generationId, call_index: 1, is_mock: false }]);
  });

  it('accepts the exact atomic three-image batch and rejects unsupported indices', async () => {
    const begin = vi.fn(async () => ({ status: 'ready', attempts: attempts([2, 3, 4]) }));
    await expect(
      beginPacedImageAttempts(
        input(begin, { callIndices: [2, 3, 4], deadlineMs: Date.now() + 10_000 }),
      ),
    ).resolves.toHaveLength(3);
    expect(begin).toHaveBeenCalledWith({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_call_indices: [2, 3, 4],
      p_generation_enabled: true,
    });

    const unsupported = vi.fn();
    await expect(
      beginPacedImageAttempts(input(unsupported, { callIndices: [2, 4] })),
    ).rejects.toThrow('IMAGE_PACING_CALL_INDICES_INVALID');
    await expect(
      beginPacedImageAttempts(input(unsupported, { callIndices: [1.5] })),
    ).rejects.toThrow('IMAGE_PACING_CALL_INDICES_INVALID');
    expect(unsupported).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'waiting', wait_ms: 0 }],
    [{ status: 'waiting', wait_ms: 1601 }],
    [{ status: 'waiting', wait_ms: 1, extra: true }],
    [{ status: 'unknown', wait_ms: 100 }],
  ])('fails closed on malformed waiting response %j without retrying it', async (result) => {
    const begin = vi.fn(async () => result);
    await expect(beginPacedImageAttempts(input(begin))).rejects.toThrow(
      'IMAGE_PACING_RESPONSE_INVALID',
    );
    expect(begin).toHaveBeenCalledOnce();
  });

  it('does not retry an ambiguous RPC error', async () => {
    const failure = new Error('database connection lost');
    const begin = vi.fn(async () => {
      throw failure;
    });
    await expect(beginPacedImageAttempts(input(begin))).rejects.toBe(failure);
    expect(begin).toHaveBeenCalledOnce();
  });

  it.each([
    [{ status: 'ready', attempts: attempts([1], '33333333-3333-4333-8333-333333333333') }],
    [{ status: 'ready', attempts: attempts([2]) }],
    [
      {
        status: 'ready',
        attempts: [
          { ...attempts([1])[0], attempt_id: '33333333-3333-4333-8333-333333333333' },
          { ...attempts([1])[0], attempt_id: '33333333-3333-4333-8333-333333333333' },
        ],
      },
    ],
    [{ status: 'ready', attempts: [{ ...attempts([1])[0], is_mock: true }] }],
  ])('rejects malformed ready attempts before returning them %j', async (result) => {
    const begin = vi.fn(async () => result);
    await expect(beginPacedImageAttempts(input(begin))).rejects.toThrow(
      /IMAGE_PACING_(RESPONSE|ATTEMPTS)_INVALID/,
    );
    expect(begin).toHaveBeenCalledOnce();
  });

  it('rejects a late ready response after the claim deadline', async () => {
    let now = 100;
    const begin = vi.fn(async () => {
      now = 200;
      return { status: 'ready', attempts: attempts([1]) };
    });
    await expect(
      beginPacedImageAttempts(input(begin, { now: () => now, deadlineMs: 200 })),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(begin).toHaveBeenCalledOnce();
  });

  it('interrupts a pending wait when the generation signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new DOMException('deadline exceeded', 'TimeoutError');
      const begin = vi.fn(async () => ({ status: 'waiting', wait_ms: 1500 }));
      const pending = beginPacedImageAttempts(
        input(begin, { signal: controller.signal, deadlineMs: Date.now() + 60_000 }),
      );
      const rejected = expect(pending).rejects.toBe(reason);
      setTimeout(() => controller.abort(reason), 0);
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(begin).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([40, 80])(
    'keeps a synthetic %i-generation workload within the paced DB permit rate',
    async (workerCount) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));
      try {
        let nextSlotAt = 0;
        let attemptNumber = 0;
        const permits: Array<{ at: number; units: number }> = [];
        const runWorker = async (workerIndex: number) => {
          const workerGenerationId = crypto.randomUUID();
          let randomState = workerIndex + 1;
          const random = () => {
            randomState = (randomState * 16807) % 2147483647;
            return randomState / 2147483647;
          };
          const begin = async (args: {
            p_generation_id: string;
            p_claim_token: string;
            p_call_indices: number[];
            p_generation_enabled: true;
          }) => {
            const now = Date.now();
            if (now < nextSlotAt) {
              return { status: 'waiting', wait_ms: Math.max(1, nextSlotAt - now) };
            }
            const units = args.p_call_indices.length;
            permits.push({ at: now, units });
            nextSlotAt = now + 500 * units;
            return {
              status: 'ready',
              attempts: args.p_call_indices.map((callIndex) => ({
                attempt_id: `55555555-5555-4555-8555-${String(++attemptNumber).padStart(12, '0')}`,
                generation_id: args.p_generation_id,
                stage: 'images',
                call_index: callIndex,
                mode: 'provider',
                is_mock: false,
              })),
            };
          };
          const common = {
            generationId: workerGenerationId,
            claimToken,
            signal: new AbortController().signal,
            deadlineMs: 14 * 60_000,
            begin,
            random,
          };
          await beginPacedImageAttempts({ ...common, callIndices: [1] });
          await beginPacedImageAttempts({ ...common, callIndices: [2, 3, 4] });
        };

        const pending = Promise.all(
          Array.from({ length: workerCount }, (_, index) => runWorker(index)),
        );
        await vi.runAllTimersAsync();
        await pending;

        expect(permits).toHaveLength(workerCount * 2);
        expect(permits.reduce((total, permit) => total + permit.units, 0)).toBe(workerCount * 4);
        for (let index = 1; index < permits.length; index += 1) {
          const previous = permits[index - 1]!;
          const current = permits[index]!;
          expect(current.at - previous.at).toBeGreaterThanOrEqual(500 * previous.units);
        }

        let windowStart = 0;
        let windowUnits = 0;
        for (let index = 0; index < permits.length; index += 1) {
          windowUnits += permits[index]!.units;
          while (permits[index]!.at - permits[windowStart]!.at > 60_000) {
            windowUnits -= permits[windowStart]!.units;
            windowStart += 1;
          }
          expect(windowUnits).toBeLessThanOrEqual(123);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
