import { z } from 'zod';
import { comicSchema } from '../shared/schemas';
import { openaiGenerationProfile } from './ai/openai-generation-profile';
import { inspectImageBytes } from './ai/image-data';
import { scriptSchema } from './ai/script-schema';
import type { ProviderCallMetadata } from './ai/provider-attempts';
import type { SaveGeneratedComicInput } from './generation-save-handler';

export const maxImageBytes = 8 * 1024 * 1024;
const maxComicBytes = 16 * 1024 * 1024;
const maxComicPixels = 16_777_216;
const mediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
const indexSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const assetMetadataInputSchema = z.strictObject({
  index: indexSchema,
  media_type: mediaTypeSchema,
  byte_size: z.number().int().min(1).max(maxImageBytes),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const savedAssetMetadataSchema = assetMetadataInputSchema.extend({
  asset_id: z.uuid(),
  object_path: z.string().min(1).max(160),
});

export const saveTaskSchema = z.strictObject({
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

export const operationSchema = z.discriminatedUnion('status', [
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
export const claimTokenSchema = z.object({ claim_token: z.uuid() });

export type AssetMetadataInput = z.infer<typeof assetMetadataInputSchema>;
export type SavedAssetMetadata = z.infer<typeof savedAssetMetadataSchema>;
export type SaveTask = z.infer<typeof saveTaskSchema>;
export type OperationResult = z.infer<typeof operationSchema>;

export class InvalidStoredImageError extends Error {
  constructor() {
    super('GENERATION_SAVE_IMAGE_INVALID');
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
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

function assertAssetOrder(assets: readonly SavedAssetMetadata[]): void {
  if (
    assets.length !== 4 ||
    assets.some((asset, index) => asset.index !== index + 1) ||
    new Set(assets.map((asset) => asset.asset_id)).size !== 4 ||
    new Set(assets.map((asset) => asset.object_path)).size !== 4
  )
    throw new Error('GENERATION_SAVE_MANIFEST_INVALID');
}

export function comicFromTask(task: SaveTask) {
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

export function validateTaskAssets(
  assets: readonly SavedAssetMetadata[],
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

export function validateTaskIdentity(task: SaveTask, input: SaveGeneratedComicInput): void {
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

export function validateProviderCalls(input: SaveGeneratedComicInput): void {
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

export async function inputManifest(input: SaveGeneratedComicInput) {
  if (input.rendered.panels.length !== 4) throw new Error('GENERATION_SAVE_IMAGE_ORDER_INVALID');
  let totalBytes = 0;
  let totalPixels = 0;
  const assets: AssetMetadataInput[] = [];
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

export function manifestMatchesInput(
  manifest: readonly SavedAssetMetadata[],
  input: AssetMetadataInput[],
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

export function operationResult(value: unknown, generationId: string): OperationResult {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success || parsed.data.generation_id !== generationId)
    throw new Error('GENERATION_SAVE_RPC_RESULT_INVALID');
  return parsed.data;
}

export function resultComic(value: unknown, expected: unknown): boolean {
  const parsed = comicSchema.safeParse(value);
  return parsed.success && stableJson(parsed.data) === stableJson(expected);
}

export function savedComicMatchesScript(
  value: unknown,
  script: z.infer<typeof scriptSchema>,
): boolean {
  const parsed = comicSchema.safeParse(value);
  if (!parsed.success || parsed.data.visual.kind !== 'panels') return false;
  return (
    parsed.data.visual.textMode === 'external' &&
    new Set(parsed.data.visual.assetIds).size === 4 &&
    stableJson({ title: parsed.data.title, panels: parsed.data.panels }) === stableJson(script)
  );
}

export function terminalStatus(
  value: OperationResult,
): 'pending' | 'succeeded' | 'failed' | 'cancelled' {
  return value.status === 'claimed' ? 'pending' : value.status;
}

export async function verifyDownloadedImage(
  bytes: Uint8Array,
  asset: SavedAssetMetadata,
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
