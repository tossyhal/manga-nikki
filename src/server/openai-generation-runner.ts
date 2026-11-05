import { z } from 'zod';
import { OpenAIImageProvider, openaiImageModelProfile } from './ai/openai-image-provider';
import { validateRenderedComic } from './ai/image-provider';
import {
  openaiGenerationProfile,
  openaiGenerationSnapshotSchema,
} from './ai/openai-generation-profile';
import { OpenAIScriptProvider, openaiScriptModelProfile } from './ai/openai-script-provider';
import type {
  ProviderAttemptHooks,
  ProviderCallMetadata,
  ProviderStage,
} from './ai/provider-attempts';
import type { ImageProvider } from './ai/image-provider';
import type { ScriptProvider } from './ai/script-provider';
import { scriptSchema } from './ai/script-schema';
import type { Environment } from './mode';
import { callGenerationRpc, getGenerationQueue } from './live-generations';
import type { SaveGeneratedComic } from './generation-save-handler';

const providerAttemptSchema = z.strictObject({
  attempt_id: z.uuid(),
  generation_id: z.uuid(),
  stage: z.enum(['script', 'images']),
  call_index: z.number().int().positive(),
  mode: z.literal('provider'),
  is_mock: z.literal(false),
});
const finishAttemptSchema = z.strictObject({
  attempt_id: z.uuid(),
  state: z.enum(['succeeded', 'failed', 'unknown']),
  request_id: z.string().min(1).max(200).nullable(),
  finished_at: z.iso.datetime({ offset: true }),
  is_mock: z.literal(false),
});
const metadataSchema = z.strictObject({
  stage: z.enum(['script', 'images']),
  callIndex: z.number().int().positive(),
  modelId: z.string().trim().min(1).max(200),
  requestId: z.string().min(1).max(200).optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().safe().optional(),
      outputTokens: z.number().int().nonnegative().safe().optional(),
      totalTokens: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
});
const savingResultSchema = z.strictObject({
  generation_id: z.uuid(),
  status: z.literal('running'),
  stage: z.literal('saving'),
});
const saveResultSchema = z.strictObject({
  generationId: z.uuid(),
  status: z.literal('succeeded'),
});

const overallTimeoutMs = 14 * 60_000;

export type ClaimedOpenAIGeneration = Readonly<{
  generation_id: string;
  entry_id: string;
  owner_id: string;
  entry_revision: number;
  diary_date: string;
  is_mock: boolean;
  input_snapshot: string;
  model_profile_snapshot: Record<string, unknown>;
  claim_token: string;
  deadline_at: string;
}>;

export type OpenAIGenerationRuntime = Readonly<{
  saveGeneratedComic?: SaveGeneratedComic;
  createScriptProvider?: (apiKey: string) => ScriptProvider;
  createImageProvider?: (apiKey: string) => ImageProvider;
}>;

export function openAIGenerationConsumerReady(
  environment: Environment,
  runtime: OpenAIGenerationRuntime,
): boolean {
  return Boolean(
    environment.GENERATION_ENABLED === 'true' &&
    environment.OPENAI_API_KEY?.trim() &&
    getGenerationQueue(environment) &&
    typeof runtime.saveGeneratedComic === 'function',
  );
}

function expectedModel(stage: ProviderStage): string {
  return stage === 'script'
    ? openaiGenerationProfile.scriptModel
    : openaiGenerationProfile.imageModel;
}

export async function runOpenAIGeneration(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  claim: ClaimedOpenAIGeneration,
  runtime: OpenAIGenerationRuntime,
): Promise<'handed-off'> {
  const profile = openaiGenerationSnapshotSchema.safeParse(claim.model_profile_snapshot);
  if (claim.is_mock || !profile.success) throw new Error('OPENAI_GENERATION_PROFILE_INVALID');

  const saveGeneratedComic = runtime.saveGeneratedComic;
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!saveGeneratedComic || !apiKey || environment.GENERATION_ENABLED !== 'true')
    throw new Error('OPENAI_GENERATION_DISABLED');

  const claimDeadlineMs = Date.parse(claim.deadline_at);
  const deadlineMs = Math.min(claimDeadlineMs, Date.now() + overallTimeoutMs);
  if (!Number.isFinite(claimDeadlineMs) || deadlineMs <= Date.now())
    throw new Error('OPENAI_GENERATION_DEADLINE_EXPIRED');

  const generationController = new AbortController();
  const overallTimer = setTimeout(
    () =>
      generationController.abort(new DOMException('Generation deadline exceeded', 'TimeoutError')),
    deadlineMs - Date.now(),
  );
  const attemptIds = new Map<string, string>();
  const metadata = new Map<string, ProviderCallMetadata>();
  const key = (stage: ProviderStage, callIndex: number) => `${stage}:${callIndex}`;

  const attemptHooks: ProviderAttemptHooks = {
    begin: async (stage, callIndex) => {
      if (
        (stage === 'script' && callIndex !== 1) ||
        (stage === 'images' && (callIndex < 1 || callIndex > profile.data.max_image_calls)) ||
        attemptIds.has(key(stage, callIndex))
      )
        throw new Error('PROVIDER_ATTEMPT_ORDER_INVALID');

      const result = await callGenerationRpc(environment, fetcher, 'begin_provider_attempt', {
        p_generation_id: claim.generation_id,
        p_claim_token: claim.claim_token,
        p_stage: stage,
        p_call_index: callIndex,
        p_generation_enabled: true,
      });
      const parsed = providerAttemptSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.generation_id !== claim.generation_id ||
        parsed.data.stage !== stage ||
        parsed.data.call_index !== callIndex
      )
        throw new Error('PROVIDER_ATTEMPT_INVALID');
      attemptIds.set(key(stage, callIndex), parsed.data.attempt_id);
      return parsed.data.attempt_id;
    },
    finish: async (stage, callIndex, attemptId, outcome) => {
      const expectedAttemptId = attemptIds.get(key(stage, callIndex));
      if (!expectedAttemptId || expectedAttemptId !== attemptId)
        throw new Error('PROVIDER_ATTEMPT_ID_INVALID');
      const requestId = outcome.metadata?.requestId ?? outcome.requestId ?? null;
      if (requestId !== null && (requestId.length < 1 || requestId.length > 200))
        throw new Error('PROVIDER_REQUEST_ID_INVALID');

      const result = await callGenerationRpc(environment, fetcher, 'finish_provider_attempt', {
        p_generation_id: claim.generation_id,
        p_claim_token: claim.claim_token,
        p_attempt_id: attemptId,
        p_state: outcome.state,
        p_request_id: requestId,
      });
      const parsed = finishAttemptSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.attempt_id !== attemptId ||
        parsed.data.state !== outcome.state ||
        parsed.data.request_id !== requestId
      )
        throw new Error('PROVIDER_ATTEMPT_FINISH_INVALID');

      if (outcome.state === 'succeeded') {
        const parsedMetadata = metadataSchema.safeParse(outcome.metadata);
        if (
          !parsedMetadata.success ||
          parsedMetadata.data.stage !== stage ||
          parsedMetadata.data.callIndex !== callIndex ||
          parsedMetadata.data.modelId !== expectedModel(stage)
        )
          throw new Error('PROVIDER_METADATA_INVALID');
        metadata.set(key(stage, callIndex), parsedMetadata.data);
      }
    },
  };

  try {
    const scriptProvider = runtime.createScriptProvider
      ? runtime.createScriptProvider(apiKey)
      : new OpenAIScriptProvider(apiKey);
    const imageProvider = runtime.createImageProvider
      ? runtime.createImageProvider(apiKey)
      : new OpenAIImageProvider(apiKey);
    const script = scriptSchema.parse(
      await scriptProvider.createScript(
        {
          id: claim.entry_id,
          diaryDate: claim.diary_date,
          body: claim.input_snapshot,
          revision: claim.entry_revision,
        },
        {
          signal: generationController.signal,
          generationId: claim.generation_id,
          callIndex: 1,
          modelProfile: {
            provider: openaiScriptModelProfile.provider,
            modelId: openaiScriptModelProfile.modelId,
          },
          attemptHooks,
        },
      ),
    );

    const rendered = validateRenderedComic(
      await imageProvider.render(script, {
        signal: generationController.signal,
        generationId: claim.generation_id,
        callIndex: 1,
        modelProfile: {
          provider: openaiImageModelProfile.provider,
          modelId: openaiImageModelProfile.modelId,
        },
        attemptHooks,
      }),
      openaiGenerationProfile.imageModel,
    );

    const scriptMetadata = metadata.get(key('script', 1));
    const imageMetadata = [1, 2, 3, 4].map((callIndex) => metadata.get(key('images', callIndex)));
    if (
      !scriptMetadata ||
      imageMetadata.some((item) => item === undefined) ||
      metadata.size !== 5 ||
      attemptIds.size !== 5
    )
      throw new Error('PROVIDER_ATTEMPTS_INCOMPLETE');

    const saving = await callGenerationRpc(environment, fetcher, 'mark_generation_saving', {
      p_generation_id: claim.generation_id,
      p_claim_token: claim.claim_token,
    });
    const parsedSaving = savingResultSchema.safeParse(saving);
    if (!parsedSaving.success || parsedSaving.data.generation_id !== claim.generation_id)
      throw new Error('GENERATION_SAVING_TRANSITION_INVALID');

    const result = await saveGeneratedComic(
      {
        generation: {
          generationId: claim.generation_id,
          entryId: claim.entry_id,
          ownerId: claim.owner_id,
          entryRevision: claim.entry_revision,
          diaryDate: claim.diary_date,
          claimToken: claim.claim_token,
          deadlineAt: claim.deadline_at,
        },
        profileId: profile.data.profile_id,
        script,
        rendered,
        providerCalls: {
          script: scriptMetadata,
          images: imageMetadata as ProviderCallMetadata[],
        },
      },
      { environment, signal: generationController.signal },
    );
    const parsedResult = saveResultSchema.safeParse(result);
    if (!parsedResult.success || parsedResult.data.generationId !== claim.generation_id)
      throw new Error('GENERATION_SAVE_RESULT_INVALID');
    return 'handed-off';
  } finally {
    clearTimeout(overallTimer);
  }
}
