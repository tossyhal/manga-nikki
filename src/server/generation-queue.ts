import { z } from 'zod';
import { pageComic } from '../shared/fixtures';
import { comicSchema } from '../shared/schemas';
import type { Environment } from './mode';
import {
  callGenerationRpc,
  getGenerationQueue,
  type GenerationQueueBinding,
} from './live-generations';
import { resolveMode } from './mode';
import { openAIGenerationConsumerReady, runOpenAIGeneration } from './openai-generation-runner';
import type { OpenAIGenerationRuntime } from './openai-generation-runner';
import { GenerationSavePendingError } from './generation-save-handler';

const queueBodySchema = z.strictObject({ generationId: z.uuid() });
const claimIdentitySchema = z.object({
  generation_id: z.uuid(),
  claim_token: z.uuid(),
});
const claimSchema = z.object({
  generation_id: z.uuid(),
  entry_id: z.uuid(),
  owner_id: z.uuid(),
  entry_revision: z.number().int().positive(),
  diary_date: z.iso.date(),
  is_mock: z.boolean(),
  input_snapshot: z.string().refine((value) => {
    const count = [...value].length;
    return count >= 1 && count <= 1000;
  }),
  model_profile_snapshot: z.record(z.string(), z.unknown()),
  claim_token: z.uuid(),
  deadline_at: z.iso.datetime({ offset: true }),
});
const profileSchema = z.object({
  profile_id: z.string().trim().min(1),
  is_mock: z.literal(true),
  max_cost_micro_usd: z.number().int().nonnegative(),
  max_image_calls: z.number().int().min(1).max(4).optional(),
});
const attemptSchema = z.object({
  attempt_id: z.uuid(),
  generation_id: z.uuid(),
  stage: z.enum(['script', 'images']),
  call_index: z.number().int().positive(),
  mode: z.enum(['mock', 'provider']),
  is_mock: z.boolean(),
});
const reconcileSchema = z.array(
  z.strictObject({
    generation_id: z.uuid(),
    action: z.enum(['enqueue', 'cancel', 'expire', 'recover-saving']),
  }),
);
const recoverResultSchema = z.strictObject({
  generationId: z.uuid(),
  status: z.enum(['pending', 'succeeded', 'failed', 'cancelled']),
});
const maxSaveRecoveriesPerRun = 3;
const saveRecoveryTimeoutMs = 120_000;

export interface GenerationQueueMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface GenerationQueueBatch {
  readonly queue: string;
  readonly messages: readonly GenerationQueueMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rpc(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return callGenerationRpc(environment, fetcher, name, args);
}

function generationComic(generationId: string) {
  if (pageComic.visual.kind !== 'page') throw new Error('MOCK_PAGE_FIXTURE_REQUIRED');
  return comicSchema.parse({
    ...pageComic,
    visual: { ...pageComic.visual, assetId: generationId },
  });
}

async function beginAttempt(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  generationId: string,
  claimToken: string,
  stage: 'script' | 'images',
) {
  const data = await rpc(environment, fetcher, 'begin_provider_attempt', {
    p_generation_id: generationId,
    p_claim_token: claimToken,
    p_stage: stage,
    p_call_index: 1,
    p_generation_enabled: false,
  });
  const parsed = attemptSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.generation_id !== generationId ||
    parsed.data.stage !== stage ||
    parsed.data.call_index !== 1 ||
    parsed.data.is_mock !== true ||
    parsed.data.mode !== 'mock'
  )
    throw new Error('MOCK_ATTEMPT_INVALID');
  return parsed.data.attempt_id;
}

async function finishAttempt(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  generationId: string,
  claimToken: string,
  attemptId: string,
): Promise<void> {
  const data = await rpc(environment, fetcher, 'finish_provider_attempt', {
    p_generation_id: generationId,
    p_claim_token: claimToken,
    p_attempt_id: attemptId,
    p_state: 'succeeded',
    p_request_id: null,
  });
  if (!isRecord(data) || data.is_mock !== true || data.state !== 'succeeded')
    throw new Error('MOCK_ATTEMPT_FINISH_INVALID');
}

async function failClaimedGeneration(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  generationId: string,
  claimToken: string,
): Promise<void> {
  const data = await rpc(environment, fetcher, 'fail_or_hold_generation', {
    p_generation_id: generationId,
    p_claim_token: claimToken,
    p_terminal_status: 'failed',
  });
  if (
    !isRecord(data) ||
    data.generation_id !== generationId ||
    !['failed', 'cancelled', 'unknown', 'succeeded'].includes(String(data.status))
  )
    throw new Error('GENERATION_FAILURE_RESULT_INVALID');
}

export async function processGenerationMessage(
  environment: Environment,
  generationId: string,
  fetcher?: typeof fetch,
  runtime: OpenAIGenerationRuntime = {},
): Promise<'ignored' | 'duplicate' | 'succeeded' | 'handed-off' | 'saving-pending' | 'failed'> {
  let currentMode;
  try {
    currentMode = resolveMode(environment, false);
  } catch {
    return 'ignored';
  }
  if (currentMode === 'local-connected') {
    // 固定mock経路は実AIの停止設定から独立させる。
  } else if (currentMode !== 'live-demo' || !openAIGenerationConsumerReady(environment, runtime)) {
    return 'ignored';
  }

  const claimValue = await rpc(environment, fetcher, 'claim_generation', {
    p_generation_id: generationId,
  });
  if (claimValue === null) return 'duplicate';
  const claim = claimSchema.safeParse(claimValue);
  if (!claim.success) {
    const claimIdentity = claimIdentitySchema.safeParse(claimValue);
    if (!claimIdentity.success || claimIdentity.data.generation_id !== generationId) {
      throw new Error('GENERATION_CLAIM_INVALID');
    }
    await failClaimedGeneration(
      environment,
      fetcher,
      claimIdentity.data.generation_id,
      claimIdentity.data.claim_token,
    );
    return 'failed';
  }
  if (claim.data.generation_id !== generationId) {
    throw new Error('GENERATION_CLAIM_INVALID');
  }
  const claimToken = claim.data.claim_token;

  try {
    if (currentMode === 'live-demo') {
      await runOpenAIGeneration(environment, fetcher, claim.data, runtime);
      return 'handed-off';
    }

    const profile = profileSchema.safeParse(claim.data.model_profile_snapshot);
    if (!claim.data.is_mock || !profile.success) {
      await failClaimedGeneration(environment, fetcher, generationId, claimToken);
      return 'ignored';
    }

    const scriptAttempt = await beginAttempt(
      environment,
      fetcher,
      generationId,
      claimToken,
      'script',
    );
    await finishAttempt(environment, fetcher, generationId, claimToken, scriptAttempt);

    const imageAttempt = await beginAttempt(
      environment,
      fetcher,
      generationId,
      claimToken,
      'images',
    );
    await finishAttempt(environment, fetcher, generationId, claimToken, imageAttempt);

    const comic = generationComic(generationId);
    const completed = await rpc(environment, fetcher, 'complete_mock_generation', {
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_comic_json: comic,
    });
    if (
      !isRecord(completed) ||
      completed.generation_id !== generationId ||
      completed.status !== 'succeeded' ||
      completed.reservation_state !== 'consumed'
    )
      throw new Error('MOCK_COMPLETION_INVALID');
    return 'succeeded';
  } catch (error) {
    if (error instanceof GenerationSavePendingError) return 'saving-pending';
    await failClaimedGeneration(environment, fetcher, generationId, claimToken);
    return 'failed';
  }
}

export async function consumeGenerationQueue(
  batch: GenerationQueueBatch,
  environment: Environment,
  fetcher?: typeof fetch,
  runtime: OpenAIGenerationRuntime = {},
): Promise<void> {
  let processableMode = false;
  try {
    const currentMode = resolveMode(environment, false);
    processableMode = currentMode === 'local-connected' || currentMode === 'live-demo';
  } catch {
    // Invalid or unconfigured modes must never start a generator.
  }

  for (const message of batch.messages) {
    const body = queueBodySchema.safeParse(message.body);
    if (!body.success || !processableMode) {
      message.ack();
      continue;
    }
    try {
      await processGenerationMessage(environment, body.data.generationId, fetcher, runtime);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

export async function reconcileGenerationQueue(
  environment: Environment,
  fetcher?: typeof fetch,
  runtime: OpenAIGenerationRuntime = {},
): Promise<void> {
  let canReconcile = false;
  let currentMode: ReturnType<typeof resolveMode> | undefined;
  try {
    currentMode = resolveMode(environment, false);
    canReconcile = currentMode === 'local-connected' || currentMode === 'live-demo';
  } catch {
    // Invalid or unconfigured modes must not inspect or change individual data.
  }
  const queue = getGenerationQueue(environment);
  if (!canReconcile) return;

  const rows = await rpc(environment, fetcher, 'list_generation_reconcile_candidates_v2', {
    p_limit: 25,
  });
  const parsed = reconcileSchema.safeParse(rows);
  if (!parsed.success) throw new Error('GENERATION_RECONCILE_RESULT_INVALID');

  let candidateFailed = false;
  let recoveryCount = 0;
  const actionPriority = (action: (typeof parsed.data)[number]['action']) =>
    action === 'enqueue' ? 1 : action === 'recover-saving' ? 2 : 0;
  const candidates = [...parsed.data].sort(
    (left, right) => actionPriority(left.action) - actionPriority(right.action),
  );
  for (const candidate of candidates) {
    try {
      if (candidate.action === 'enqueue') {
        if (!queue) continue;
        if (currentMode === 'live-demo' && !openAIGenerationConsumerReady(environment, runtime))
          continue;
        await queue.send({ generationId: candidate.generation_id });
        await rpc(environment, fetcher, 'mark_generation_enqueued', {
          p_generation_id: candidate.generation_id,
        });
        continue;
      }
      if (candidate.action === 'recover-saving') {
        if (
          currentMode !== 'live-demo' ||
          !runtime.recoverGeneratedComic ||
          recoveryCount >= maxSaveRecoveriesPerRun
        )
          continue;
        const recoveryClaimed = await rpc(environment, fetcher, 'begin_generation_save_recovery', {
          p_generation_id: candidate.generation_id,
        });
        if (recoveryClaimed === false) continue;
        if (recoveryClaimed !== true) throw new Error('GENERATION_RECOVERY_LEASE_INVALID');
        recoveryCount += 1;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), saveRecoveryTimeoutMs);
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          abortListener = () => reject(new Error('GENERATION_RECOVERY_TIMEOUT'));
          if (controller.signal.aborted) abortListener();
          else controller.signal.addEventListener('abort', abortListener, { once: true });
        });
        try {
          const result = await Promise.race([
            runtime.recoverGeneratedComic(candidate.generation_id, {
              environment,
              signal: controller.signal,
            }),
            aborted,
          ]);
          const recovered = recoverResultSchema.safeParse(result);
          if (!recovered.success || recovered.data.generationId !== candidate.generation_id)
            throw new Error('GENERATION_RECOVERY_RESULT_INVALID');
        } finally {
          clearTimeout(timeout);
          if (abortListener) controller.signal.removeEventListener('abort', abortListener);
        }
        continue;
      }
      await rpc(environment, fetcher, 'fail_or_hold_generation', {
        p_generation_id: candidate.generation_id,
        p_claim_token: null,
        p_terminal_status: 'failed',
      });
    } catch {
      candidateFailed = true;
    }
  }
  if (candidateFailed) throw new Error('GENERATION_RECONCILE_FAILED');
}

export async function sendGenerationToQueue(
  queue: GenerationQueueBinding,
  generationId: string,
): Promise<void> {
  await queue.send({ generationId });
}
