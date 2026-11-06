import { parseGenerationRow } from './generation-row';
import { z } from 'zod';
import { type Entry, type EntryDetail, type Generation } from '../shared/schemas';
import type { Environment } from './mode';
import { createServerRpcClient, createUserSupabaseClient } from './supabase-clients';

export class LiveEntryError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
  ) {
    super(code);
  }
}

type Context = {
  environment: Environment;
  owner: string;
  accessToken: string;
  fetcher?: typeof fetch;
};

const entryColumns = 'id,diary_date,body,revision,latest_generation_id,created_at,updated_at';
const entryRowSchema = z.object({
  id: z.uuid(),
  diary_date: z.iso.date(),
  body: z.string().refine((value) => {
    const count = [...value].length;
    return value.trim() === value && count >= 1 && count <= 1000;
  }),
  revision: z.number().int().positive(),
  latest_generation_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
const cursorSchema = z.strictObject({ diaryDate: z.iso.date(), id: z.uuid() });

const rpcFailures: Record<string, { status: LiveEntryError['status']; code: string }> = {
  AUTH_REQUIRED: { status: 401, code: 'AUTH_REQUIRED' },
  INVALID_INPUT: { status: 400, code: 'INVALID_INPUT' },
  CONSENT_REQUIRED: { status: 403, code: 'CONSENT_REQUIRED' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  REVISION_CONFLICT: { status: 409, code: 'REVISION_CONFLICT' },
  ENTRY_BUSY: { status: 409, code: 'ENTRY_BUSY' },
  DRAFT_LIMIT_REACHED: { status: 429, code: 'DRAFT_LIMIT_REACHED' },
};

function unavailable(): LiveEntryError {
  return new LiveEntryError(503, 'DEPENDENCY_UNAVAILABLE');
}

function invalidInput(): LiveEntryError {
  return new LiveEntryError(400, 'INVALID_INPUT');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readError(error: unknown): never {
  if (isRecord(error) && error.status === 401) throw new LiveEntryError(401, 'AUTH_REQUIRED');
  throw unavailable();
}

function rpcError(error: unknown): never {
  if (isRecord(error) && error.code === 'P0001' && typeof error.message === 'string') {
    const failure = Object.hasOwn(rpcFailures, error.message)
      ? rpcFailures[error.message]
      : undefined;
    if (failure) throw new LiveEntryError(failure.status, failure.code);
  }
  throw unavailable();
}

function rowFromRpc(data: unknown): unknown {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  if (!isRecord(row)) throw unavailable();
  return row;
}

function isoTimestamp(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function mapEntry(value: unknown): Entry {
  const parsed = entryRowSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const createdAt = isoTimestamp(parsed.data.created_at);
  const updatedAt = isoTimestamp(parsed.data.updated_at);
  if (!createdAt || !updatedAt) throw unavailable();
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

function encodeCursor(entry: Entry): string {
  return btoa(JSON.stringify({ diaryDate: entry.diaryDate, id: entry.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeCursor(value: string): z.infer<typeof cursorSchema> {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidInput();
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    const cursor = cursorSchema.safeParse(parsed);
    if (!cursor.success) throw invalidInput();
    return cursor.data;
  } catch (error) {
    if (error instanceof LiveEntryError) throw error;
    throw invalidInput();
  }
}

function mapGeneration(value: unknown, entry: Entry): Generation {
  const generation = parseGenerationRow(value);
  if (
    !generation ||
    generation.entryId !== entry.id ||
    generation.id !== entry.latestGenerationId ||
    generation.entryRevision > entry.revision
  )
    throw unavailable();
  return generation;
}

function mapLastSuccessfulGeneration(value: unknown, entry: Entry): Generation | null {
  const generation = parseGenerationRow(value);
  if (
    !generation ||
    generation.entryId !== entry.id ||
    generation.status !== 'succeeded' ||
    generation.entryRevision > entry.revision
  )
    return null;
  return generation;
}

export async function createLiveEntry(
  context: Context,
  input: {
    createRequestId: string;
    diaryDate: string;
    body: string;
    consentVersion: 'v1';
  },
): Promise<Entry> {
  const client = createServerRpcClient(context.environment, context.fetcher);
  const { data, error } = await client.rpc('create_entry', {
    p_actor_id: context.owner,
    p_create_request_id: input.createRequestId,
    p_diary_date: input.diaryDate,
    p_body: input.body,
    p_consent_version: input.consentVersion,
  });
  if (error) rpcError(error);
  return mapEntry(rowFromRpc(data));
}

export async function listLiveEntries(
  context: Context,
  { cursor: cursorValue, limit }: { cursor?: string; limit: number },
): Promise<{ items: Entry[]; nextCursor: string | null }> {
  const client = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const cursor = cursorValue ? decodeCursor(cursorValue) : undefined;
  let query = client
    .from('entries')
    .select(entryColumns)
    .eq('owner_id', context.owner)
    .is('deleted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('diary_date', { ascending: false })
    .order('id', { ascending: false });
  if (cursor) {
    query = query.or(
      `diary_date.lt.${cursor.diaryDate},and(diary_date.eq.${cursor.diaryDate},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query.limit(limit + 1);
  if (error) readError(error);
  if (!Array.isArray(data)) throw unavailable();
  const rows = data.map(mapEntry);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const lastItem = items[items.length - 1];
  return { items, nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null };
}

export async function getLiveEntryDetail(
  context: Context,
  id: string,
): Promise<EntryDetail | null> {
  if (!z.uuid().safeParse(id).success) throw invalidInput();
  const client = createUserSupabaseClient(
    context.environment,
    context.accessToken,
    context.fetcher,
  );
  const { data, error } = await client
    .from('entries')
    .select(entryColumns)
    .eq('id', id)
    .eq('owner_id', context.owner)
    .is('deleted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) readError(error);
  if (!data) return null;
  const entry = mapEntry(data);

  const latestResult = entry.latestGenerationId
    ? await client
        .from('generations')
        .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
        .eq('id', entry.latestGenerationId)
        .eq('entry_id', entry.id)
        .eq('owner_id', context.owner)
        .maybeSingle()
    : { data: null, error: null };
  if (latestResult.error) readError(latestResult.error);
  const latestGeneration = latestResult.data ? mapGeneration(latestResult.data, entry) : null;
  if (entry.latestGenerationId && !latestGeneration) throw unavailable();
  if (latestGeneration?.status === 'succeeded') {
    return {
      ...entry,
      latestGeneration,
      lastSuccessfulGeneration: latestGeneration,
    };
  }

  const successfulResult = await client
    .from('generations')
    .select('id,entry_id,entry_revision,status,stage,comic_json,is_mock')
    .eq('entry_id', entry.id)
    .eq('owner_id', context.owner)
    .eq('status', 'succeeded')
    .lte('entry_revision', entry.revision)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (successfulResult.error) readError(successfulResult.error);
  const lastSuccessfulGeneration = successfulResult.data
    ? mapLastSuccessfulGeneration(successfulResult.data, entry)
    : null;
  return { ...entry, latestGeneration, lastSuccessfulGeneration };
}

export async function updateLiveEntry(
  context: Context,
  id: string,
  input: { expectedRevision: number; diaryDate: string; body: string },
): Promise<Entry> {
  if (!z.uuid().safeParse(id).success) throw invalidInput();
  const client = createServerRpcClient(context.environment, context.fetcher);
  const { data, error } = await client.rpc('update_entry', {
    p_actor_id: context.owner,
    p_entry_id: id,
    p_expected_revision: input.expectedRevision,
    p_diary_date: input.diaryDate,
    p_body: input.body,
  });
  if (error) rpcError(error);
  return mapEntry(rowFromRpc(data));
}

export async function deleteLiveEntry(
  context: Context,
  id: string,
): Promise<{ deletionAccepted: true }> {
  if (!z.uuid().safeParse(id).success) throw invalidInput();
  const client = createServerRpcClient(context.environment, context.fetcher);
  const { data, error } = await client.rpc('request_entry_deletion', {
    p_actor_id: context.owner,
    p_entry_id: id,
  });
  if (error) rpcError(error);
  if (!isRecord(data) || data.deletionAccepted !== true) throw unavailable();
  return { deletionAccepted: true };
}
