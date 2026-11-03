import { z } from 'zod';
import { comicSchema, type Entry, type Generation } from '../shared/schemas';
import type { Environment } from './mode';
import { createServerRpcClient, createUserSupabaseClient } from './supabase-clients';

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
const generationRowSchema = z.object({
  id: z.uuid(),
  entry_id: z.uuid(),
  entry_revision: z.number().int().positive(),
  status: generationStatusSchema,
  stage: z.enum(['script', 'images', 'saving']).nullable(),
  comic_json: z.unknown().nullable(),
  is_mock: z.boolean().nullable(),
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
  let response: Response;
  try {
    const body = new FormData();
    body.set('secret', secret);
    body.set('response', token);
    response = await (context.turnstileFetch ?? fetch)(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body, signal: controller.signal },
    );
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }

  let result: z.infer<typeof turnstileResponseSchema>;
  try {
    if (!response.ok) throw unavailable();
    const parsed = turnstileResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw unavailable();
    result = parsed.data;
  } catch {
    throw unavailable();
  }

  if (
    !result.success ||
    result.action !== 'generate_comic' ||
    !result.hostname ||
    !hostnames.includes(result.hostname.toLowerCase())
  )
    throw new LiveGenerationError(403, 'CAPTCHA_FAILED');
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

export async function getLiveGenerationQuota(
  context: GenerationContext,
  capableEnvironment: boolean,
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
      capableEnvironment && parsed.data.generation_available && parsed.data.profile_is_mock,
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
  const parsed = generationRowSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const row = parsed.data;
  if (
    row.entry_id !== entry.id ||
    (!allowHistorical && row.id !== entry.latestGenerationId) ||
    row.is_mock === null
  )
    throw unavailable();

  const base = {
    id: row.id,
    entryId: row.entry_id,
    entryRevision: row.entry_revision,
    mock: row.is_mock,
  };
  if (row.status === 'queued') {
    if (row.stage !== null) throw unavailable();
    return { ...base, status: 'queued', stage: null };
  }
  if (row.status === 'running') {
    if (!row.stage) throw unavailable();
    return { ...base, status: 'running', stage: row.stage };
  }
  if (row.stage !== null) throw unavailable();
  if (row.status === 'succeeded') {
    const comic = comicSchema.safeParse(row.comic_json);
    if (!comic.success) throw unavailable();
    return { ...base, status: 'succeeded', stage: null, comic: comic.data };
  }
  if (row.status === 'failed' || row.status === 'unknown') {
    const unknown = row.status === 'unknown';
    return {
      ...base,
      status: row.status,
      stage: null,
      error: {
        code: unknown ? 'RESULT_UNKNOWN' : 'GENERATION_FAILED',
        message: unknown ? '生成結果を確認できません。' : '漫画を作成できませんでした。',
        retryable: false,
      },
    };
  }
  return { ...base, status: 'cancelled', stage: null };
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

export async function getLiveMockAssetUrl(
  context: GenerationContext,
  assetId: string,
): Promise<{ url: '/sample-comic.svg'; expiresAt: string } | null> {
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
  if (!generation) return null;
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
