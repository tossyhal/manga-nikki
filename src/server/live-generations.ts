import { generationRowSchema, parseGenerationRow } from './generation-row';
import { z } from 'zod';
import { comicSchema, type Entry, type Generation } from '../shared/schemas';
import type { Environment } from './mode';
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

function unavailable(): LiveGenerationError {
  return new LiveGenerationError(503, 'DEPENDENCY_UNAVAILABLE');
}

function rpcError(error: unknown): never {
  if (isRecord(error) && error.code === 'P0001' && typeof error.message === 'string') {
    const failure = rpcFailures[error.message];
    if (failure) throw new LiveGenerationError(failure.status, failure.code);
  }
  throw unavailable();
}

export async function callGenerationRpc(
  environment: Environment,
  fetcher: typeof fetch | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = createServerRpcClient(environment, fetcher);
  const { data, error } = await client.rpc(name, args);
  if (error) rpcError(error);
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

  const { data: entry, error: entryError } = await userClient
    .from('entries')
    .select('id')
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

  const serverAssets = createServerAssetMetadataClient(context.environment, context.fetcher);
  const { data: storedAsset, error: storedAssetError } = await serverAssets.getAsset(assetId);
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

export { getLiveAssetUrl as getLiveMockAssetUrl };
