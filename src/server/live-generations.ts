import { generationRowSchema, parseGenerationRow } from './generation-row';
import { z } from 'zod';
import { comicSchema, type Entry, type Generation } from '../shared/schemas';
import type { Environment } from './mode';
import { generationOwnerAllowed } from './generation-owner';
import {
  createServerAssetMetadataClient,
  createServerRpcClient,
  createUserSupabaseClient,
} from './supabase-clients';
import { createServerAssetSigningClient } from './supabase-storage';
import { supabaseUrl } from './supabase-config';

const generationStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);
const receiptSchema = z.strictObject({
  generation_id: z.uuid(),
  status: generationStatusSchema,
  status_url: z.string(),
});
const quotaSchema = z.strictObject({
  remaining_today: z.number().int().nonnegative(),
  active_generation_id: z.uuid().nullable(),
  reset_at: z.iso.datetime({ offset: true }),
  generation_available: z.boolean(),
  profile_is_mock: z.boolean(),
});
const entryRowSchema = z.object({
  id: z.uuid(),
  diary_date: z.iso.date(),
  body: z.string(),
  revision: z.number().int().positive(),
  latest_generation_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
const mediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
const turnstileResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export type GenerationReceipt = {
  generationId: string;
  status: z.infer<typeof generationStatusSchema>;
  statusUrl: string;
};

export type GenerationContext = {
  environment: Environment;
  owner: string;
  accessToken: string;
  fetcher?: typeof fetch;
  turnstileFetch?: typeof fetch;
};

export type GenerationQueueBinding = {
  send(message: { generationId: string }): Promise<unknown>;
};

export class LiveGenerationError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    public readonly retryableDependency = false,
  ) {
    super(code);
  }
}

const rpcFailures: Record<string, { status: LiveGenerationError['status']; code: string }> = {
  AUTH_REQUIRED: { status: 401, code: 'AUTH_REQUIRED' },
  INVALID_INPUT: { status: 400, code: 'INVALID_INPUT' },
  CONSENT_REQUIRED: { status: 403, code: 'CONSENT_REQUIRED' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  REVISION_CONFLICT: { status: 409, code: 'REVISION_CONFLICT' },
  REVISION_ALREADY_GENERATED: { status: 409, code: 'REVISION_ALREADY_GENERATED' },
  ENTRY_BUSY: { status: 409, code: 'ENTRY_BUSY' },
  USER_LIMIT_REACHED: { status: 429, code: 'USER_LIMIT_REACHED' },
  GLOBAL_LIMIT_REACHED: { status: 429, code: 'GLOBAL_LIMIT_REACHED' },
  TOO_MANY_ACTIVE: { status: 429, code: 'TOO_MANY_ACTIVE' },
  DRAFT_LIMIT_REACHED: { status: 429, code: 'DRAFT_LIMIT_REACHED' },
  GENERATION_DISABLED: { status: 503, code: 'GENERATION_DISABLED' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(retryableDependency = false): LiveGenerationError {
  return new LiveGenerationError(503, 'DEPENDENCY_UNAVAILABLE', retryableDependency);
}

function rpcError(error: unknown, status: number): never {
  if (isRecord(error) && error.code === 'P0001' && typeof error.message === 'string') {
    const failure = rpcFailures[error.message];
    if (failure) throw new LiveGenerationError(failure.status, failure.code);
    throw unavailable();
  }
  if (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599 && status !== 501 && status !== 505)
  )
    throw unavailable(true);
  throw unavailable();
}

export async function callGenerationRpc(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = createServerRpcClient(environment, fetcher);
  const { data, error, status } = await client.rpc(name, args);
  if (error) rpcError(error, status);
  return data;
}

function mapReceipt(value: unknown): GenerationReceipt {
  const parsed = receiptSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.status_url !== `/api/v1/generations/${parsed.data.generation_id}`
  )
    throw unavailable();
  return {
    generationId: parsed.data.generation_id,
    status: parsed.data.status,
    statusUrl: parsed.data.status_url,
  };
}

export function getGenerationQueue(environment: Environment): GenerationQueueBinding | null {
  const value = environment.GENERATION_QUEUE;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('send' in value) ||
    typeof value.send !== 'function'
  )
    return null;
  return value as GenerationQueueBinding;
}

function allowedHostnames(environment: Environment): string[] {
  const value = environment.TURNSTILE_ALLOWED_HOSTNAMES?.trim();
  if (!value) return [];
  const hostnames = value.split(',').map((hostname) => hostname.trim().toLowerCase());
  if (
    hostnames.some(
      (hostname) =>
        hostname.length > 253 ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
        hostname.includes('..'),
    )
  )
    return [];
  return [...new Set(hostnames)];
}

export function generationIngressConfigured(environment: Environment): boolean {
  return Boolean(
    getGenerationQueue(environment) &&
    environment.TURNSTILE_SECRET_KEY?.trim() &&
    allowedHostnames(environment).length > 0,
  );
}

export function openAIGenerationIngressConfigured(
  environment: Environment,
  saveHandlerReady: boolean,
  recoveryHandlerReady: boolean,
): boolean {
  return Boolean(
    environment.GENERATION_ENABLED === 'true' &&
    environment.OPENAI_API_KEY?.trim() &&
    saveHandlerReady &&
    recoveryHandlerReady &&
    generationIngressConfigured(environment),
  );
}

export async function findLiveGenerationReceipt(
  context: GenerationContext,
  input: { entryId: string; expectedRevision: number; idempotencyKey: string },
): Promise<GenerationReceipt | null> {
  const value = await callGenerationRpc(
    context.environment,
    context.fetcher,
    'find_generation_receipt',
    {
      p_actor_id: context.owner,
      p_entry_id: input.entryId,
      p_expected_revision: input.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
    },
  );
  return value === null ? null : mapReceipt(value);
}

async function verifyGenerationCaptcha(context: GenerationContext, token: string): Promise<void> {
  const secret = context.environment.TURNSTILE_SECRET_KEY?.trim();
  const hostnames = allowedHostnames(context.environment);
  if (!secret || hostnames.length === 0) throw new LiveGenerationError(503, 'GENERATION_DISABLED');
  if (token.length === 0 || token.length > 2048)
    throw new LiveGenerationError(403, 'CAPTCHA_FAILED');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const body = new FormData();
    body.set('secret', secret);
    body.set('response', token);
    const response = await (context.turnstileFetch ?? fetch)(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body, signal: controller.signal },
    );
    if (!response.ok) throw unavailable();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(unavailable());
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    let responseBody: unknown;
    try {
      responseBody = await Promise.race([response.json(), aborted]);
    } finally {
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
    const parsed = turnstileResponseSchema.safeParse(responseBody);
    if (!parsed.success) throw unavailable();
    const result = parsed.data;
    if (
      !result.success ||
      result.action !== 'generate' ||
      !result.hostname ||
      !hostnames.includes(result.hostname.toLowerCase())
    )
      throw new LiveGenerationError(403, 'CAPTCHA_FAILED');
  } catch (error) {
    if (error instanceof LiveGenerationError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export async function reserveLiveMockGeneration(
  context: GenerationContext,
  input: {
    entryId: string;
    expectedRevision: number;
    idempotencyKey: string;
    captchaToken: string;
  },
): Promise<GenerationReceipt> {
  const existing = await findLiveGenerationReceipt(context, input);
  if (existing) return existing;

  if (!generationIngressConfigured(context.environment))
    throw new LiveGenerationError(503, 'GENERATION_DISABLED');

  await verifyGenerationCaptcha(context, input.captchaToken);
  const value = await callGenerationRpc(
    context.environment,
    context.fetcher,
    'reserve_mock_generation',
    {
      p_actor_id: context.owner,
      p_entry_id: input.entryId,
      p_expected_revision: input.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
    },
  );
  const receipt = mapReceipt(value);

  const queue = getGenerationQueue(context.environment);
  if (!queue) throw new LiveGenerationError(503, 'GENERATION_DISABLED');
  try {
    await queue.send({ generationId: receipt.generationId });
    await callGenerationRpc(context.environment, context.fetcher, 'mark_generation_enqueued', {
      p_generation_id: receipt.generationId,
    });
  } catch {
    // The reserved job remains authoritative and the scheduled reconciler will enqueue it later.
  }
  return receipt;
}

export async function reserveLiveOpenAIGeneration(
  context: GenerationContext,
  input: {
    entryId: string;
    expectedRevision: number;
    idempotencyKey: string;
    captchaToken: string;
  },
  saveHandlerReady: boolean,
  recoveryHandlerReady: boolean,
): Promise<GenerationReceipt> {
  const existing = await findLiveGenerationReceipt(context, input);
  if (existing) return existing;

  if (
    !generationOwnerAllowed(context.environment, context.owner) ||
    !openAIGenerationIngressConfigured(context.environment, saveHandlerReady, recoveryHandlerReady)
  )
    throw new LiveGenerationError(503, 'GENERATION_DISABLED');

  await verifyGenerationCaptcha(context, input.captchaToken);
  const value = await callGenerationRpc(
    context.environment,
    context.fetcher,
    'reserve_openai_generation',
    {
      p_actor_id: context.owner,
      p_entry_id: input.entryId,
      p_expected_revision: input.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
      p_generation_enabled: true,
    },
  );
  const receipt = mapReceipt(value);
  const queue = getGenerationQueue(context.environment);
  if (!queue) throw new LiveGenerationError(503, 'GENERATION_DISABLED');
  try {
    await queue.send({ generationId: receipt.generationId });
    await callGenerationRpc(context.environment, context.fetcher, 'mark_generation_enqueued', {
      p_generation_id: receipt.generationId,
    });
  } catch {
    // The reserved job remains authoritative and the scheduled reconciler will enqueue it later.
  }
  return receipt;
}

export async function getLiveGenerationQuota(
  context: GenerationContext,
  capableEnvironment: boolean,
  expectedProfileIsMock = true,
): Promise<{
  remainingToday: number;
  activeGenerationId: string | null;
  resetAt: string;
  generationAvailable: boolean;
}> {
  const value = await callGenerationRpc(
    context.environment,
    context.fetcher,
    'get_generation_quota',
    {
      p_actor_id: context.owner,
    },
  );
  const parsed = quotaSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return {
    remainingToday: parsed.data.remaining_today,
    activeGenerationId: parsed.data.active_generation_id,
    resetAt: new Date(parsed.data.reset_at).toISOString(),
    generationAvailable:
      capableEnvironment &&
      (expectedProfileIsMock || generationOwnerAllowed(context.environment, context.owner)) &&
      parsed.data.generation_available &&
      parsed.data.profile_is_mock === expectedProfileIsMock,
  };
}

function toEntry(value: unknown): Entry {
  const parsed = entryRowSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const createdAt = new Date(parsed.data.created_at).toISOString();
  const updatedAt = new Date(parsed.data.updated_at).toISOString();
  return {
    id: parsed.data.id,
    diaryDate: parsed.data.diary_date,
    body: parsed.data.body,
    revision: parsed.data.revision,
    latestGenerationId: parsed.data.latest_generation_id,
    createdAt,
    updatedAt,
  };
}

function mapGeneration(value: unknown, entry: Entry, allowHistorical: boolean): Generation {
  const generation = parseGenerationRow(value);
  if (
    !generation ||
    generation.entryId !== entry.id ||
    (!allowHistorical && generation.id !== entry.latestGenerationId)
  )
    throw unavailable();
  return generation;
}

export async function getLiveGeneration(
  context: GenerationContext,
  generationId: string,
): Promise<Generation | null> {
  if (!z.uuid().safeParse(generationId).success)
    throw new LiveGenerationError(400, 'INVALID_INPUT');
  const client = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const { data: generation, error: generationError } = await client
    .from('generations')
    .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
    .eq('id', generationId)
    .eq('owner_id', context.owner)
    .maybeSingle();
  if (generationError) {
    if (generationError.code === 'PGRST116') return null;
    if ('status' in generationError && generationError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!generation) return null;

  const parsedGeneration = generationRowSchema.safeParse(generation);
  if (!parsedGeneration.success) throw unavailable();
  const { data: entry, error: entryError } = await client
    .from('entries')
    .select('id,diary_date,body,revision,latest_generation_id,created_at,updated_at')
    .eq('id', parsedGeneration.data.entry_id)
    .eq('owner_id', context.owner)
    .is('deleted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (entryError) {
    if ('status' in entryError && entryError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!entry) return null;
  return mapGeneration(generation, toEntry(entry), true);
}

export async function getLiveAssetUrl(
  context: GenerationContext,
  assetId: string,
): Promise<{ url: string; expiresAt: string } | null> {
  if (!z.uuid().safeParse(assetId).success) throw new LiveGenerationError(400, 'INVALID_INPUT');
  const client = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const { data: generation, error } = await client
    .from('generations')
    .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
    .eq('id', assetId)
    .eq('owner_id', context.owner)
    .maybeSingle();
  if (error) {
    if ('status' in error && error.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!generation) return getLiveComicAssetUrl(context, assetId);
  const parsed = generationRowSchema.safeParse(generation);
  if (!parsed.success) throw unavailable();
  if (
    parsed.data.status !== 'succeeded' ||
    parsed.data.is_mock !== true ||
    parsed.data.stage !== null
  )
    return null;
  const comic = comicSchema.safeParse(parsed.data.comic_json);
  if (
    !comic.success ||
    comic.data.visual.kind !== 'page' ||
    comic.data.visual.assetId !== parsed.data.id
  )
    return null;

  const { data: entry, error: entryError } = await client
    .from('entries')
    .select('id')
    .eq('id', parsed.data.entry_id)
    .eq('owner_id', context.owner)
    .is('deleted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (entryError) {
    if ('status' in entryError && entryError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!entry) return null;
  return { url: '/sample-comic.svg', expiresAt: new Date(Date.now() + 60000).toISOString() };
}

const privateAssetSchema = z.strictObject({
  id: z.uuid(),
  generation_id: z.uuid(),
  owner_id: z.uuid(),
  object_path: z.string().min(1).max(160),
  media_type: mediaTypeSchema,
});

function expectedPrivateAssetPath(
  ownerId: string,
  generationId: string,
  assetId: string,
  mediaType: string,
): string {
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
  return `${ownerId.toLowerCase()}/${generationId.toLowerCase()}/${assetId.toLowerCase()}.${extension}`;
}

function comicContainsAsset(value: unknown, assetId: string): boolean {
  const parsed = comicSchema.safeParse(value);
  if (!parsed.success) return false;
  return parsed.data.visual.kind === 'page'
    ? parsed.data.visual.assetId === assetId
    : parsed.data.visual.assetIds.includes(assetId);
}

async function getLiveComicAssetMetadata(
  context: GenerationContext,
  assetId: string,
): Promise<z.infer<typeof privateAssetSchema> | null> {
  const userClient = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const { data: assetReference, error: referenceError } = await userClient
    .from('assets')
    .select('id,generation_id')
    .eq('id', assetId)
    .maybeSingle();
  if (referenceError) {
    if ('status' in referenceError && referenceError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!assetReference) return null;
  const reference = z
    .strictObject({ id: z.uuid(), generation_id: z.uuid() })
    .safeParse(assetReference);
  if (!reference.success || reference.data.id !== assetId) throw unavailable();

  const { data: generation, error: generationError } = await userClient
    .from('generations')
    .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
    .eq('id', reference.data.generation_id)
    .eq('owner_id', context.owner)
    .maybeSingle();
  if (generationError) {
    if ('status' in generationError && generationError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!generation) return null;
  const parsedGeneration = generationRowSchema.safeParse(generation);
  if (
    !parsedGeneration.success ||
    parsedGeneration.data.id !== reference.data.generation_id ||
    parsedGeneration.data.status !== 'succeeded' ||
    parsedGeneration.data.stage !== null ||
    parsedGeneration.data.is_mock !== false ||
    !comicContainsAsset(parsedGeneration.data.comic_json, assetId)
  )
    return null;

  const entryQuery = userClient
    .from('entries')
    .select('id')
    .eq('id', parsedGeneration.data.entry_id)
    .eq('owner_id', context.owner)
    .is('deleted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  let serverAssets: ReturnType<typeof createServerAssetMetadataClient>;
  try {
    serverAssets = createServerAssetMetadataClient(context.environment, context.fetcher);
  } catch {
    const { data: entry, error: entryError } = await entryQuery;
    if (entryError) {
      if ('status' in entryError && entryError.status === 401)
        throw new LiveGenerationError(401, 'AUTH_REQUIRED');
      throw unavailable();
    }
    if (!entry) return null;
    throw unavailable();
  }
  const [{ data: entry, error: entryError }, { data: storedAsset, error: storedAssetError }] =
    await Promise.all([entryQuery, serverAssets.getAsset(assetId)]);
  if (entryError) {
    if ('status' in entryError && entryError.status === 401)
      throw new LiveGenerationError(401, 'AUTH_REQUIRED');
    throw unavailable();
  }
  if (!entry) return null;

  if (storedAssetError) throw unavailable();
  const parsedAsset = privateAssetSchema.safeParse(storedAsset);
  if (
    !parsedAsset.success ||
    parsedAsset.data.id !== assetId ||
    parsedAsset.data.generation_id !== parsedGeneration.data.id ||
    parsedAsset.data.owner_id !== context.owner ||
    parsedAsset.data.object_path !==
      expectedPrivateAssetPath(
        context.owner,
        parsedGeneration.data.id,
        assetId,
        parsedAsset.data.media_type,
      )
  )
    return null;
  return parsedAsset.data;
}

async function getLiveComicAssetUrl(
  context: GenerationContext,
  assetId: string,
): Promise<{ url: string; expiresAt: string } | null> {
  const asset = await getLiveComicAssetMetadata(context, assetId);
  if (!asset) return null;

  const signingStartedAt = Date.now();
  const storage = createServerAssetSigningClient(context.environment, context.fetcher);
  const { data, error } = await storage.createSignedUrl(asset.object_path, 60);
  if (error || !data || typeof data.signedUrl !== 'string') throw unavailable();

  let signedUrl: URL;
  let expectedOrigin: string;
  try {
    signedUrl = new URL(data.signedUrl);
    expectedOrigin = new URL(supabaseUrl(context.environment)).origin;
  } catch {
    throw unavailable();
  }
  if (
    signedUrl.origin !== expectedOrigin ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.hash ||
    !signedUrl.pathname.startsWith('/storage/v1/object/sign/comics/')
  )
    throw unavailable();

  const currentAsset = await getLiveComicAssetMetadata(context, assetId);
  if (!currentAsset || currentAsset.object_path !== asset.object_path) return null;
  return {
    url: signedUrl.toString(),
    expiresAt: new Date(signingStartedAt + 60_000).toISOString(),
  };
}

const signedAssetResultSchema = z.object({
  error: z.string().nullable(),
  path: z.string().nullable(),
  signedUrl: z.string().nullable(),
});

function liveAssetReadError(error: unknown): never {
  if (isRecord(error) && error.status === 401) throw new LiveGenerationError(401, 'AUTH_REQUIRED');
  throw unavailable();
}

function privateAssetsById(
  value: unknown,
  assetIds: string[],
  ownerId: string,
  generationId: string,
): Map<string, z.infer<typeof privateAssetSchema>> | null {
  if (!Array.isArray(value) || value.length !== assetIds.length) return null;
  const expectedIds = new Set(assetIds);
  const result = new Map<string, z.infer<typeof privateAssetSchema>>();
  for (const candidate of value) {
    const parsed = privateAssetSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !expectedIds.has(parsed.data.id) ||
      result.has(parsed.data.id) ||
      parsed.data.generation_id !== generationId ||
      parsed.data.owner_id !== ownerId ||
      parsed.data.object_path !==
        expectedPrivateAssetPath(ownerId, generationId, parsed.data.id, parsed.data.media_type)
    )
      return null;
    result.set(parsed.data.id, parsed.data);
  }
  return result.size === assetIds.length ? result : null;
}

function samePrivateAsset(
  left: z.infer<typeof privateAssetSchema>,
  right: z.infer<typeof privateAssetSchema>,
): boolean {
  return (
    left.id === right.id &&
    left.generation_id === right.generation_id &&
    left.owner_id === right.owner_id &&
    left.object_path === right.object_path &&
    left.media_type === right.media_type
  );
}

function signedAssetUrl(value: string, path: string, environment: Environment): string | null {
  try {
    const url = new URL(value);
    const expectedOrigin = new URL(supabaseUrl(environment)).origin;
    if (
      url.origin !== expectedOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `/storage/v1/object/sign/comics/${path}`
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

function succeededAssetGeneration(value: unknown, generationId: string) {
  const row = generationRowSchema.safeParse(value);
  const generation = parseGenerationRow(value);
  if (
    !row.success ||
    !generation ||
    row.data.id !== generationId ||
    generation.status !== 'succeeded' ||
    generation.stage !== null
  )
    return null;
  return { row: row.data, generation };
}

function sameAssetGeneration(
  previous: ReturnType<typeof succeededAssetGeneration>,
  current: ReturnType<typeof succeededAssetGeneration>,
): boolean {
  if (!previous || !current) return false;
  const previousComic = comicSchema.safeParse(previous.row.comic_json);
  const currentComic = comicSchema.safeParse(current.row.comic_json);
  return Boolean(
    previousComic.success &&
    currentComic.success &&
    previous.row.entry_id === current.row.entry_id &&
    previous.row.entry_revision === current.row.entry_revision &&
    previous.row.status === current.row.status &&
    previous.row.stage === current.row.stage &&
    previous.row.is_mock === current.row.is_mock &&
    JSON.stringify(previousComic.data) === JSON.stringify(currentComic.data),
  );
}

export async function getLiveGenerationAssets(
  context: GenerationContext,
  generationId: string,
): Promise<{ id: string; url: string; expiresAt: string }[] | null> {
  if (!z.uuid().safeParse(generationId).success)
    throw new LiveGenerationError(400, 'INVALID_INPUT');

  const client = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const readGeneration = () =>
    client
      .from('generations')
      .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
      .eq('id', generationId)
      .eq('owner_id', context.owner)
      .maybeSingle();
  const { data: generationRow, error: generationError } = await readGeneration();
  if (generationError) liveAssetReadError(generationError);
  const initialGeneration = succeededAssetGeneration(generationRow, generationId);
  if (!initialGeneration) return null;

  const comic = comicSchema.safeParse(initialGeneration.row.comic_json);
  if (!comic.success) return null;
  const assetIds =
    comic.data.visual.kind === 'page' ? [comic.data.visual.assetId] : comic.data.visual.assetIds;

  const readEntry = () =>
    client
      .from('entries')
      .select('id')
      .eq('id', initialGeneration.row.entry_id)
      .eq('owner_id', context.owner)
      .is('deleted_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

  if (
    initialGeneration.row.is_mock === true &&
    comic.data.visual.kind === 'page' &&
    comic.data.visual.assetId === generationId
  ) {
    const { data: entry, error: entryError } = await readEntry();
    if (entryError) liveAssetReadError(entryError);
    if (!entry) return null;
    return [
      {
        id: generationId,
        url: '/sample-comic.svg',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
  }

  if (initialGeneration.row.is_mock !== false) return null;

  let metadataClient: ReturnType<typeof createServerAssetMetadataClient>;
  try {
    metadataClient = createServerAssetMetadataClient(context.environment, context.fetcher);
  } catch {
    throw unavailable();
  }

  const [entryResult, assetsResult] = await Promise.all([
    readEntry(),
    metadataClient.getAssets(assetIds),
  ]);
  if (entryResult.error) liveAssetReadError(entryResult.error);
  if (!entryResult.data) return null;
  if (entryResult.data.id !== initialGeneration.row.entry_id) throw unavailable();
  if (assetsResult.error) throw unavailable();
  const initialAssets = privateAssetsById(assetsResult.data, assetIds, context.owner, generationId);
  if (!initialAssets) return null;

  const signingStartedAt = Date.now();
  const storage = createServerAssetSigningClient(context.environment, context.fetcher);
  const paths = assetIds.map((id) => initialAssets.get(id)!.object_path);
  const { data: signedRows, error: signingError } = await storage.createSignedUrls(paths, 60);
  if (signingError || !Array.isArray(signedRows) || signedRows.length !== paths.length)
    throw unavailable();

  const signedUrls = new Map<string, string>();
  for (const value of signedRows) {
    const parsed = signedAssetResultSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.error !== null ||
      !parsed.data.path ||
      !parsed.data.signedUrl ||
      signedUrls.has(parsed.data.path)
    )
      throw unavailable();
    const expectedAsset = [...initialAssets.values()].find(
      (asset) => asset.object_path === parsed.data.path,
    );
    const url = expectedAsset
      ? signedAssetUrl(parsed.data.signedUrl, expectedAsset.object_path, context.environment)
      : null;
    if (!url) throw unavailable();
    signedUrls.set(parsed.data.path, url);
  }
  if (paths.some((path) => !signedUrls.has(path))) throw unavailable();

  const [currentGenerationResult, currentEntryResult, currentAssetsResult] = await Promise.all([
    readGeneration(),
    readEntry(),
    metadataClient.getAssets(assetIds),
  ]);
  if (currentGenerationResult.error) liveAssetReadError(currentGenerationResult.error);
  if (currentEntryResult.error) liveAssetReadError(currentEntryResult.error);
  if (currentAssetsResult.error) throw unavailable();
  const currentGeneration = succeededAssetGeneration(currentGenerationResult.data, generationId);
  if (!sameAssetGeneration(initialGeneration, currentGeneration)) return null;
  if (!currentEntryResult.data) return null;
  if (currentEntryResult.data.id !== initialGeneration.row.entry_id) throw unavailable();
  const currentAssets = privateAssetsById(
    currentAssetsResult.data,
    assetIds,
    context.owner,
    generationId,
  );
  if (!currentAssets) return null;
  for (const id of assetIds) {
    const previous = initialAssets.get(id);
    const current = currentAssets.get(id);
    if (!previous || !current || !samePrivateAsset(previous, current)) return null;
  }

  const expiresAt = new Date(signingStartedAt + 60_000).toISOString();
  return assetIds.map((id) => {
    const asset = initialAssets.get(id)!;
    return { id, url: signedUrls.get(asset.object_path)!, expiresAt };
  });
}

export { getLiveAssetUrl as getLiveMockAssetUrl };
