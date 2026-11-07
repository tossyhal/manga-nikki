import { z } from 'zod';

const providerAttemptSchema = z.strictObject({
  attempt_id: z.uuid(),
  generation_id: z.uuid(),
  stage: z.literal('images'),
  call_index: z.number().int().positive(),
  mode: z.literal('provider'),
  is_mock: z.literal(false),
});

const beginPacedImageAttemptsResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('waiting'),
    wait_ms: z.number().int().min(1).max(1600),
  }),
  z.strictObject({
    status: z.literal('ready'),
    attempts: z.array(providerAttemptSchema),
  }),
]);

const maxJitterMs = 1000;
const minJitterMs = 25;

export type PacedImageAttempt = z.infer<typeof providerAttemptSchema>;

export type BeginPacedImageAttemptsInput = Readonly<{
  generationId: string;
  claimToken: string;
  callIndices: readonly number[];
  signal: AbortSignal;
  deadlineMs: number;
  begin: (args: {
    p_generation_id: string;
    p_claim_token: string;
    p_call_indices: number[];
    p_generation_enabled: true;
  }) => Promise<unknown>;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function isSupportedCallIndices(callIndices: readonly number[]): boolean {
  return (
    (callIndices.length === 1 &&
      Number.isInteger(callIndices[0]) &&
      callIndices[0]! >= 1 &&
      callIndices[0]! <= 4) ||
    (callIndices.length === 3 && callIndices.every((callIndex, index) => callIndex === index + 2))
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function assertActive(signal: AbortSignal, deadlineMs: number, now: () => number): void {
  signal.throwIfAborted();
  if (now() >= deadlineMs) {
    throw new DOMException('Generation deadline exceeded', 'TimeoutError');
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateReadyAttempts(
  attempts: readonly PacedImageAttempt[],
  generationId: string,
  callIndices: readonly number[],
): PacedImageAttempt[] {
  if (
    attempts.length !== callIndices.length ||
    attempts.some(
      (attempt, index) =>
        attempt.generation_id !== generationId || attempt.call_index !== callIndices[index],
    ) ||
    new Set(attempts.map((attempt) => attempt.attempt_id)).size !== attempts.length
  ) {
    throw new Error('IMAGE_PACING_ATTEMPTS_INVALID');
  }
  return [...attempts];
}

export async function beginPacedImageAttempts(
  input: BeginPacedImageAttemptsInput,
): Promise<PacedImageAttempt[]> {
  if (!isSupportedCallIndices(input.callIndices)) {
    throw new Error('IMAGE_PACING_CALL_INDICES_INVALID');
  }

  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;
  const callIndices = [...input.callIndices];

  while (true) {
    assertActive(input.signal, input.deadlineMs, now);
    const result = await input.begin({
      p_generation_id: input.generationId,
      p_claim_token: input.claimToken,
      p_call_indices: callIndices,
      p_generation_enabled: true,
    });
    assertActive(input.signal, input.deadlineMs, now);

    const parsed = beginPacedImageAttemptsResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error('IMAGE_PACING_RESPONSE_INVALID');
    if (parsed.data.status === 'ready') {
      return validateReadyAttempts(parsed.data.attempts, input.generationId, callIndices);
    }

    const randomValue = random();
    if (!Number.isFinite(randomValue)) throw new Error('IMAGE_PACING_JITTER_INVALID');
    const boundedRandom = Math.max(0, Math.min(1, randomValue));
    const jitterMs = minJitterMs + Math.floor(boundedRandom * (maxJitterMs - minJitterMs));
    await sleep(parsed.data.wait_ms + jitterMs, input.signal);
  }
}
