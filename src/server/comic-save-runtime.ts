import { z } from 'zod';
import { comicSchema } from '../shared/schemas';
import { openaiGenerationProfile } from './ai/openai-generation-profile';
import { inspectImageBytes } from './ai/image-data';
import { scriptSchema } from './ai/script-schema';
import type { ProviderCallMetadata } from './ai/provider-attempts';
import type { Environment } from './mode';
import {
  assertOperationActive,
  createOperationSignal,
  createSupabaseGenerationSaveBackend,
  InvalidStoredImageError,
  isMissingStorageObject,
  isTemporary,
  MissingStoredImageError,
  saveLeaseMs,
} from './comic-save-backend';
import type { GenerationSaveBackend, GenerationSaveBackendFactory } from './comic-save-backend';
import type {
  RecoverGeneratedComic,
  SaveGeneratedComic,
  SaveGeneratedComicInput,
} from './generation-save-handler';

export {
  createSupabaseGenerationSaveBackend,
  fetchWithAbortSignal,
  GenerationSaveDependencyError,
} from './comic-save-backend';
export type { GenerationSaveBackend, GenerationSaveBackendFactory } from './comic-save-backend';

const maxImageBytes = 8 * 1024 * 1024;
const maxComicBytes = 16 * 1024 * 1024;
const maxComicPixels = 16_777_216;
const mediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
const indexSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const assetMetadataInputSchema = z.strictObject({
  index: indexSchema,
  media_type: mediaTypeSchema,
  byte_size: z.number().int().min(1).max(maxImageBytes),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const savedAssetMetadataSchema = assetMetadataInputSchema.extend({
  asset_id: z.uuid(),
  object_path: z.string().min(1).max(160),
});
const saveTaskSchema = z.strictObject({
  owner_id: z.uuid(),
  entry_id: z.uuid(),
  entry_revision: z.number().int().positive(),
  diary_date: z.iso.date(),
  claim_token: z.uuid(),
  deadline_at: z.iso.datetime({ offset: true }),
  profile_id: z.string().trim().min(1).max(200),
  script: scriptSchema,
  comic_draft: comicSchema,
  asset_metadata: z.array(savedAssetMetadataSchema).length(4),
});
const operationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    generation_id: z.uuid(),
    save_claim_token: z.uuid(),
    lease_expires_at: z.iso.datetime({ offset: true }),
    task: z.unknown(),
  }),
  z.strictObject({ status: z.literal('pending'), generation_id: z.uuid() }),
  z.strictObject({
    status: z.literal('succeeded'),
    generation_id: z.uuid(),
    comic_json: z.unknown(),
    asset_ids: z.array(z.uuid()).optional(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    generation_id: z.uuid(),
    reservation_state: z.enum(['consumed', 'held', 'released']).nullable().optional(),
    released: z.boolean().optional(),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    generation_id: z.uuid(),
    reservation_state: z.enum(['consumed', 'held', 'released']).nullable().optional(),
    released: z.boolean().optional(),
  }),
]);

class PermanentSaveError extends Error {
  constructor() {
    super('GENERATION_SAVE_PERMANENT_FAILURE');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectedObjectPath(
  ownerId: string,
  generationId: string,
  assetId: string,
  mediaType: string,
): string {
  const suffix = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
  return `${ownerId.toLowerCase()}/${generationId.toLowerCase()}/${assetId.toLowerCase()}.${suffix}`;
}

function assertAssetOrder(assets: readonly z.infer<typeof savedAssetMetadataSchema>[]): void {
  if (
    assets.length !== 4 ||
    assets.some((asset, index) => asset.index !== index + 1) ||
    new Set(assets.map((asset) => asset.asset_id)).size !== 4 ||
    new Set(assets.map((asset) => asset.object_path)).size !== 4
  )
    throw new Error('GENERATION_SAVE_MANIFEST_INVALID');
}

function comicFromTask(task: z.infer<typeof saveTaskSchema>) {
  assertAssetOrder(task.asset_metadata);
  const comic = comicSchema.parse({
    schemaVersion: 1,
    title: task.script.title,
    panels: task.script.panels,
    visual: {
      kind: 'panels',
      assetIds: task.asset_metadata.map((asset) => asset.asset_id),
      textMode: 'external',
    },
  });
  if (stableJson(comic) !== stableJson(task.comic_draft))
    throw new Error('GENERATION_SAVE_COMIC_INVALID');
  return comic;
}

function validateTaskAssets(
  assets: readonly z.infer<typeof savedAssetMetadataSchema>[],
  ownerId: string,
  generationId: string,
): void {
  assertAssetOrder(assets);
  let totalBytes = 0;
  let totalPixels = 0;
  for (const asset of assets) {
    if (
      asset.object_path !==
      expectedObjectPath(ownerId, generationId, asset.asset_id, asset.media_type)
    )
      throw new Error('GENERATION_SAVE_PATH_INVALID');
    if (asset.width * asset.height > 4_194_304)
      throw new Error('GENERATION_SAVE_DIMENSIONS_INVALID');
    totalBytes += asset.byte_size;
    totalPixels += asset.width * asset.height;
  }
  if (totalBytes > maxComicBytes || totalPixels > maxComicPixels)
    throw new Error('GENERATION_SAVE_LIMIT_EXCEEDED');
}

function validateTaskIdentity(
  task: z.infer<typeof saveTaskSchema>,
  input: SaveGeneratedComicInput,
): void {
  const { generation } = input;
  if (
    task.owner_id !== generation.ownerId ||
    task.entry_id !== generation.entryId ||
    task.entry_revision !== generation.entryRevision ||
    task.diary_date !== generation.diaryDate ||
    task.claim_token !== generation.claimToken ||
    Date.parse(task.deadline_at) !== Date.parse(generation.deadlineAt) ||
    task.profile_id !== input.profileId ||
    stableJson(task.script) !== stableJson(input.script)
  )
    throw new Error('GENERATION_SAVE_TASK_CONFLICT');
}

function validateProviderCalls(input: SaveGeneratedComicInput): void {
  const expectedImages: ProviderCallMetadata[] = [1, 2, 3, 4].map((callIndex) => ({
    stage: 'images',
    callIndex,
    modelId: openaiGenerationProfile.imageModel,
  }));
  const allCalls = [input.providerCalls.script, ...input.providerCalls.images];
  if (
    input.profileId !== openaiGenerationProfile.profileId ||
    input.rendered.kind !== 'panels' ||
    input.rendered.textMode !== 'external' ||
    input.rendered.modelId !== openaiGenerationProfile.imageModel ||
    input.rendered.panels.length !== 4 ||
    input.providerCalls.script.stage !== 'script' ||
    input.providerCalls.script.callIndex !== 1 ||
    input.providerCalls.script.modelId !== openaiGenerationProfile.scriptModel ||
    input.providerCalls.images.length !== expectedImages.length ||
    input.providerCalls.images.some(
      (call, index) =>
        call.stage !== 'images' ||
        call.callIndex !== expectedImages[index]!.callIndex ||
        call.modelId !== expectedImages[index]!.modelId,
    ) ||
    allCalls.length !== 5
  )
    throw new Error('GENERATION_SAVE_PROVIDER_METADATA_INVALID');
}

async function inputManifest(input: SaveGeneratedComicInput) {
  if (input.rendered.panels.length !== 4) throw new Error('GENERATION_SAVE_IMAGE_ORDER_INVALID');
  let totalBytes = 0;
  let totalPixels = 0;
  const assets = [];
  for (let index = 0; index < 4; index += 1) {
    const panel = input.rendered.panels[index]!;
    if (panel.index !== index + 1) throw new Error('GENERATION_SAVE_IMAGE_ORDER_INVALID');
    const dimensions = inspectImageBytes(panel.data, mediaTypeSchema.parse(panel.mediaType));
    const checksum = await sha256(panel.data);
    totalBytes += panel.data.byteLength;
    totalPixels += dimensions.width * dimensions.height;
    assets.push({
      index: panel.index,
      media_type: panel.mediaType,
      byte_size: panel.data.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      sha256: checksum,
    });
  }
  if (totalBytes > maxComicBytes || totalPixels > maxComicPixels)
    throw new Error('GENERATION_SAVE_LIMIT_EXCEEDED');
  return assetMetadataInputSchema.array().length(4).parse(assets);
}

function manifestMatchesInput(
  manifest: readonly z.infer<typeof savedAssetMetadataSchema>[],
  input: z.infer<typeof assetMetadataInputSchema>[],
): boolean {
  return manifest.every((asset, index) => {
    const expected = input[index];
    return (
      expected !== undefined &&
      asset.index === expected.index &&
      asset.media_type === expected.media_type &&
      asset.byte_size === expected.byte_size &&
      asset.width === expected.width &&
      asset.height === expected.height &&
      asset.sha256 === expected.sha256
    );
  });
}

function operationResult(value: unknown, generationId: string) {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success || parsed.data.generation_id !== generationId)
    throw new Error('GENERATION_SAVE_RPC_RESULT_INVALID');
  return parsed.data;
}

function resultComic(value: unknown, expected: unknown): boolean {
  const parsed = comicSchema.safeParse(value);
  return parsed.success && stableJson(parsed.data) === stableJson(expected);
}

function savedComicMatchesScript(value: unknown, script: z.infer<typeof scriptSchema>): boolean {
  const parsed = comicSchema.safeParse(value);
  if (!parsed.success || parsed.data.visual.kind !== 'panels') return false;
  return (
    parsed.data.visual.textMode === 'external' &&
    new Set(parsed.data.visual.assetIds).size === 4 &&
    stableJson({ title: parsed.data.title, panels: parsed.data.panels }) === stableJson(script)
  );
}

function terminalStatus(
  value: z.infer<typeof operationSchema>,
): 'pending' | 'succeeded' | 'failed' | 'cancelled' {
  return value.status === 'claimed' ? 'pending' : value.status;
}

async function failSave(
  backend: GenerationSaveBackend,
  generationId: string,
  claimToken: string,
  saveClaimToken: string,
  signal: AbortSignal,
): Promise<'pending' | 'succeeded' | 'failed' | 'cancelled'> {
  assertOperationActive(signal);
  const value = operationResult(
    await backend.callRpc('fail_comic_save', {
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_save_claim_token: saveClaimToken,
    }),
    generationId,
  );
  return terminalStatus(value);
}

async function verifyDownloadedImage(
  bytes: Uint8Array,
  asset: z.infer<typeof savedAssetMetadataSchema>,
): Promise<void> {
  if (bytes.byteLength !== asset.byte_size) throw new InvalidStoredImageError();
  let dimensions: ReturnType<typeof inspectImageBytes>;
  try {
    dimensions = inspectImageBytes(bytes, asset.media_type);
  } catch {
    throw new InvalidStoredImageError();
  }
  if (
    dimensions.width !== asset.width ||
    dimensions.height !== asset.height ||
    (await sha256(bytes)) !== asset.sha256
  )
    throw new InvalidStoredImageError();
}

async function uploadInitialImages(
  backend: GenerationSaveBackend,
  input: SaveGeneratedComicInput,
  assets: readonly z.infer<typeof savedAssetMetadataSchema>[],
  signal: AbortSignal,
): Promise<void> {
  for (const asset of assets) {
    assertOperationActive(signal);
    const panel = input.rendered.panels[asset.index - 1];
    if (!panel || (await sha256(panel.data)) !== asset.sha256) throw new InvalidStoredImageError();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertOperationActive(signal);
      try {
        await backend.upload(asset.object_path, panel.data, asset.media_type);
        break;
      } catch (error) {
        if (isTemporary(error) && attempt === 0 && !signal.aborted) continue;
        if (isTemporary(error)) throw error;
        throw new PermanentSaveError();
      }
    }
  }
}

async function downloadSavedImages(
  backend: GenerationSaveBackend,
  assets: readonly z.infer<typeof savedAssetMetadataSchema>[],
  signal: AbortSignal,
): Promise<void> {
  for (const asset of assets) {
    assertOperationActive(signal);
    let bytes: Uint8Array;
    try {
      bytes = await backend.download(asset.object_path);
    } catch (error) {
      if (isMissingStorageObject(error)) throw new MissingStoredImageError();
      throw error;
    }
    await verifyDownloadedImage(bytes, asset);
  }
}

async function completeSave(
  backend: GenerationSaveBackend,
  task: z.infer<typeof saveTaskSchema>,
  generationId: string,
  saveClaimToken: string,
  signal: AbortSignal,
): Promise<'pending' | 'succeeded' | 'failed' | 'cancelled'> {
  assertOperationActive(signal);
  const comic = comicFromTask(task);
  const result = operationResult(
    await backend.callRpc('complete_comic_save', {
      p_generation_id: generationId,
      p_owner_id: task.owner_id,
      p_entry_revision: task.entry_revision,
      p_diary_date: task.diary_date,
      p_claim_token: task.claim_token,
      p_save_claim_token: saveClaimToken,
      p_profile_id: task.profile_id,
      p_comic_json: comic,
      p_asset_metadata: task.asset_metadata.map((asset) =>
        assetMetadataInputSchema.parse({
          index: asset.index,
          media_type: asset.media_type,
          byte_size: asset.byte_size,
          width: asset.width,
          height: asset.height,
          sha256: asset.sha256,
        }),
      ),
    }),
    generationId,
  );
  if (result.status === 'succeeded') {
    const expectedAssetIds = task.asset_metadata.map((asset) => asset.asset_id);
    if (
      !resultComic(result.comic_json, comic) ||
      !result.asset_ids ||
      stableJson(result.asset_ids) !== stableJson(expectedAssetIds)
    )
      return 'pending';
  }
  return terminalStatus(result);
}

function saveResult(generationId: string) {
  return { generationId, status: 'succeeded' as const };
}

async function saveGeneratedComic(
  input: SaveGeneratedComicInput,
  context: { environment: Environment; signal: AbortSignal },
  factory: GenerationSaveBackendFactory,
): Promise<ReturnType<typeof saveResult>> {
  const { generation } = input;
  let task: z.infer<typeof saveTaskSchema> | undefined;
  let saveClaimToken: string | undefined;
  let saveLeaseExpiresAt: string | undefined;
  let firstBackend: GenerationSaveBackend | undefined;
  const initialSignal = createOperationSignal(context.signal, [generation.deadlineAt]);
  try {
    assertOperationActive(initialSignal.signal);
    validateProviderCalls(input);
    const script = scriptSchema.parse(input.script);
    const manifest = await inputManifest({ ...input, script });
    firstBackend = factory(context.environment, initialSignal.signal);
    const begin = operationResult(
      await firstBackend.callRpc('begin_comic_save_task', {
        p_generation_id: generation.generationId,
        p_owner_id: generation.ownerId,
        p_entry_revision: generation.entryRevision,
        p_diary_date: generation.diaryDate,
        p_claim_token: generation.claimToken,
        p_profile_id: input.profileId,
        p_script: script,
        p_asset_metadata: manifest,
      }),
      generation.generationId,
    );
    if (begin.status === 'succeeded') {
      if (!savedComicMatchesScript(begin.comic_json, script))
        throw new Error('GENERATION_SAVE_EXISTING_RESULT_INVALID');
      return saveResult(generation.generationId);
    }
    if (begin.status !== 'claimed') throw new Error('GENERATION_SAVE_PENDING');
    saveClaimToken = begin.save_claim_token;
    saveLeaseExpiresAt = begin.lease_expires_at;
    const parsedTask = saveTaskSchema.safeParse(begin.task);
    if (!parsedTask.success) {
      await failSave(
        firstBackend,
        generation.generationId,
        generation.claimToken,
        saveClaimToken,
        initialSignal.signal,
      );
      throw new Error('GENERATION_SAVE_TASK_INVALID');
    }
    task = parsedTask.data;
    try {
      validateTaskIdentity(task, input);
      validateTaskAssets(task.asset_metadata, generation.ownerId, generation.generationId);
      comicFromTask(task);
      if (!manifestMatchesInput(task.asset_metadata, manifest))
        throw new Error('GENERATION_SAVE_TASK_CONFLICT');
    } catch {
      await failSave(
        firstBackend,
        generation.generationId,
        generation.claimToken,
        saveClaimToken,
        initialSignal.signal,
      );
      throw new Error('GENERATION_SAVE_TASK_INVALID');
    }
  } catch {
    throw new Error('GENERATION_SAVE_PENDING');
  } finally {
    initialSignal.dispose();
  }

  if (!task || !saveClaimToken || !saveLeaseExpiresAt) throw new Error('GENERATION_SAVE_PENDING');
  const operationSignal = createOperationSignal(context.signal, [
    generation.deadlineAt,
    saveLeaseExpiresAt,
    Date.parse(task.deadline_at) + 24 * 60 * 60_000,
  ]);
  try {
    const backend = factory(context.environment, operationSignal.signal);
    await uploadInitialImages(backend, input, task.asset_metadata, operationSignal.signal);
    const status = await completeSave(
      backend,
      task,
      generation.generationId,
      saveClaimToken,
      operationSignal.signal,
    );
    if (status !== 'succeeded') throw new Error('GENERATION_SAVE_PENDING');
    return saveResult(generation.generationId);
  } catch (error) {
    if (error instanceof PermanentSaveError || error instanceof InvalidStoredImageError) {
      try {
        const backend = factory(context.environment, operationSignal.signal);
        await failSave(
          backend,
          generation.generationId,
          generation.claimToken,
          saveClaimToken,
          operationSignal.signal,
        );
      } catch {
        throw new Error('GENERATION_SAVE_PENDING');
      }
    }
    throw new Error('GENERATION_SAVE_PENDING');
  } finally {
    operationSignal.dispose();
  }
}

async function recoverGeneratedComic(
  generationId: string,
  context: { environment: Environment; signal: AbortSignal },
  factory: GenerationSaveBackendFactory,
): Promise<{ generationId: string; status: 'pending' | 'succeeded' | 'failed' | 'cancelled' }> {
  const initialSignal = createOperationSignal(context.signal, [Date.now() + saveLeaseMs]);
  let backend: GenerationSaveBackend;
  let claim: z.infer<typeof operationSchema>;
  try {
    assertOperationActive(initialSignal.signal);
    backend = factory(context.environment, initialSignal.signal);
    claim = operationResult(
      await backend.callRpc('claim_comic_save_recovery', { p_generation_id: generationId }),
      generationId,
    );
  } catch {
    return { generationId, status: 'pending' };
  } finally {
    initialSignal.dispose();
  }
  if (claim.status !== 'claimed') {
    if (claim.status === 'succeeded' && !comicSchema.safeParse(claim.comic_json).success)
      return { generationId, status: 'pending' };
    return { generationId, status: claim.status };
  }

  const taskResult = saveTaskSchema.safeParse(claim.task);
  const task = taskResult.success ? taskResult.data : undefined;
  const recoverySignal = createOperationSignal(context.signal, [
    claim.lease_expires_at,
    task ? Date.parse(task.deadline_at) + 24 * 60 * 60_000 : Date.now() + saveLeaseMs,
  ]);
  try {
    backend = factory(context.environment, recoverySignal.signal);
    if (!task) {
      const taskIdentity = z.object({ claim_token: z.uuid() }).safeParse(claim.task);
      if (!taskIdentity.success) return { generationId, status: 'pending' };
      const failure = await failSave(
        backend,
        generationId,
        taskIdentity.data.claim_token,
        claim.save_claim_token,
        recoverySignal.signal,
      );
      return { generationId, status: failure };
    }
    try {
      validateTaskAssets(task.asset_metadata, task.owner_id, generationId);
      comicFromTask(task);
    } catch {
      const failure = await failSave(
        backend,
        generationId,
        task.claim_token,
        claim.save_claim_token,
        recoverySignal.signal,
      );
      return { generationId, status: failure };
    }
    try {
      await downloadSavedImages(backend, task.asset_metadata, recoverySignal.signal);
    } catch (error) {
      if (error instanceof MissingStoredImageError || error instanceof InvalidStoredImageError) {
        const failure = await failSave(
          backend,
          generationId,
          task.claim_token,
          claim.save_claim_token,
          recoverySignal.signal,
        );
        return { generationId, status: failure };
      }
      return { generationId, status: 'pending' };
    }
    const status = await completeSave(
      backend,
      task,
      generationId,
      claim.save_claim_token,
      recoverySignal.signal,
    );
    return { generationId, status };
  } catch {
    return { generationId, status: 'pending' };
  } finally {
    recoverySignal.dispose();
  }
}

export function createGenerationSaveRuntime(
  factory: GenerationSaveBackendFactory = createSupabaseGenerationSaveBackend,
): {
  saveGeneratedComic: SaveGeneratedComic;
  recoverGeneratedComic: RecoverGeneratedComic;
} {
  return {
    saveGeneratedComic: (input, context) => saveGeneratedComic(input, context, factory),
    recoverGeneratedComic: (generationId, context) =>
      recoverGeneratedComic(generationId, context, factory),
  };
}
