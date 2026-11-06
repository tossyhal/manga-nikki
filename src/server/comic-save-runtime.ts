import { comicSchema } from '../shared/schemas';
import { scriptSchema } from './ai/script-schema';
import type { Environment } from './mode';
import {
  assertOperationActive,
  createOperationSignal,
  createSupabaseGenerationSaveBackend,
  isMissingStorageObject,
  isTemporary,
  MissingStoredImageError,
  saveLeaseMs,
} from './comic-save-backend';
import type { GenerationSaveBackend, GenerationSaveBackendFactory } from './comic-save-backend';
import {
  assetMetadataInputSchema,
  claimTokenSchema,
  comicFromTask,
  inputManifest,
  InvalidStoredImageError,
  manifestMatchesInput,
  operationResult,
  resultComic,
  savedComicMatchesScript,
  saveTaskSchema,
  sha256,
  stableJson,
  terminalStatus,
  validateProviderCalls,
  validateTaskAssets,
  validateTaskIdentity,
  verifyDownloadedImage,
} from './comic-save-manifest';
import type { OperationResult, SaveTask, SavedAssetMetadata } from './comic-save-manifest';
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

class PermanentSaveError extends Error {
  constructor() {
    super('GENERATION_SAVE_PERMANENT_FAILURE');
  }
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

async function uploadInitialImages(
  backend: GenerationSaveBackend,
  input: SaveGeneratedComicInput,
  assets: readonly SavedAssetMetadata[],
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
  assets: readonly SavedAssetMetadata[],
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
  task: SaveTask,
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
  let task: SaveTask | undefined;
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
  let claim: OperationResult;
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
      const taskIdentity = claimTokenSchema.safeParse(claim.task);
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
