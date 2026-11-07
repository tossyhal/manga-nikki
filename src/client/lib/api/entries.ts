import type { Entry, EntryDetail } from '../../../shared/schemas';
import {
  api,
  ApiClientError,
  getApiAuthorizationScope,
  type ApiAuthorizationScope,
} from './client';
import { getClientConfig } from '../config';
import {
  entryReadCacheEpoch,
  getOrCreateEntryRead,
  getEntryReadCache,
  invalidateEntryReadCacheKey,
  invalidateEntryReadCache,
  isEntryReadCacheEpochCurrent,
  removeEntryReadCache,
  reconcileEntryDetailsFromList,
  setEntryReadCache,
} from './entryReadCache';

type ReadCallbacks<T> = {
  onUpdate?: (value: T, scope: ApiAuthorizationScope) => void | Promise<void>;
  onBackgroundError?: (failure: unknown, scope: ApiAuthorizationScope) => void | Promise<void>;
};

export type EntryReadOptions<T = unknown> = ReadCallbacks<T> & {
  fresh?: boolean;
  signal?: AbortSignal;
};

function canCacheEntryDetail(detail: EntryDetail) {
  if (detail.latestGenerationId === null) return true;
  return (
    detail.latestGeneration?.id === detail.latestGenerationId &&
    detail.latestGeneration.status !== 'queued' &&
    detail.latestGeneration.status !== 'running'
  );
}

async function readCachedEntry<T>(
  kind: 'entries' | 'entry',
  scope: ApiAuthorizationScope,
  path: string,
  options: EntryReadOptions<T>,
  retentionDays: number,
  canCache: (value: T) => boolean = () => true,
): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.fresh) invalidateEntryReadCacheKey(kind, scope, path);
  const cacheEpoch = entryReadCacheEpoch(kind, scope, path);
  const load = async (signal?: AbortSignal) => {
    const result = await api<T>(path, { signal }, { expectedScope: scope });
    signal?.throwIfAborted();
    if (isEntryReadCacheEpochCurrent(kind, scope, path, cacheEpoch)) {
      if (kind === 'entries') {
        const page = result as { items: Entry[]; nextCursor: string | null };
        const query = path.split('?', 2)[1] ?? '';
        const isCompleteList = !new URLSearchParams(query).has('cursor') && !page.nextCursor;
        reconcileEntryDetailsFromList(scope, page.items, isCompleteList);
      }
      const entries = kind === 'entries' ? (result as { items: Entry[] }).items : [result as Entry];
      const now = Date.now();
      const retentionBound = entries.reduce((limit, entry) => {
        const createdAt = Date.parse(entry.createdAt);
        if (!Number.isFinite(createdAt)) return 0;
        return Math.min(limit, createdAt + retentionDays * 24 * 60 * 60 * 1000 - now);
      }, 60_000);
      if (canCache(result) && retentionBound > 0)
        setEntryReadCache(kind, scope, path, result, cacheEpoch, retentionBound);
      else removeEntryReadCache(kind, scope, path);
    }
    return result;
  };
  if (!options.fresh) {
    const cached = getEntryReadCache<T>(kind, scope, path);
    if (cached.found) {
      if (cached.stale) {
        const backgroundEpoch = cacheEpoch;
        const revalidate = () =>
          getOrCreateEntryRead(kind, scope, path, backgroundEpoch, () => load());
        const isCurrentScope = async () => {
          try {
            const current = await getApiAuthorizationScope();
            return (
              current.dataMode === scope.dataMode && current.authorization === scope.authorization
            );
          } catch {
            return false;
          }
        };
        const notifyFailure = async (failure: unknown) => {
          const current = isEntryReadCacheEpochCurrent(kind, scope, path, backgroundEpoch);
          const error = failure instanceof ApiClientError ? failure : null;
          const isAuthFailure = error !== null && (error.status === 401 || error.status === 403);
          const isMissingDetail =
            kind === 'entry' && error?.status === 404 && error.code === 'NOT_FOUND';
          const invalidatedMissingDetail = isMissingDetail && current;
          if (invalidatedMissingDetail) invalidateEntryReadCacheKey(kind, scope, path);
          if (!(current || isAuthFailure || invalidatedMissingDetail)) return;
          const failureEpoch = entryReadCacheEpoch(kind, scope, path);
          if (!(await isCurrentScope())) return;
          if (!isEntryReadCacheEpochCurrent(kind, scope, path, failureEpoch)) return;
          await options.onBackgroundError?.(failure, scope);
        };
        void revalidate()
          .then(async (result) => {
            if (!isEntryReadCacheEpochCurrent(kind, scope, path, backgroundEpoch)) return;
            const current = await isCurrentScope();
            if (
              !current ||
              !isEntryReadCacheEpochCurrent(kind, scope, path, backgroundEpoch) ||
              options.signal?.aborted
            )
              return;
            await options.onUpdate?.(result, scope);
          }, notifyFailure)
          .catch(() => undefined);
      }
      return cached.value;
    }
  }
  return options.signal
    ? load(options.signal)
    : getOrCreateEntryRead(kind, scope, path, cacheEpoch, () => load());
}

export async function getEntry(id: string, options: EntryReadOptions<EntryDetail> = {}) {
  options.signal?.throwIfAborted();
  const path = `/entries/${encodeURIComponent(id)}`;
  const scope = await getApiAuthorizationScope();
  const { retentionDays } = await getClientConfig();
  options.signal?.throwIfAborted();
  try {
    return await readCachedEntry<EntryDetail>(
      'entry',
      scope,
      path,
      options,
      retentionDays,
      canCacheEntryDetail,
    );
  } catch (failure) {
    if (failure instanceof ApiClientError && failure.status === 404 && failure.code === 'NOT_FOUND')
      invalidateEntryReadCacheKey('entry', scope, path);
    throw failure;
  }
}

export async function getEntries({
  cursor,
  limit,
  signal,
  fresh = false,
  onUpdate,
  onBackgroundError,
}: {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  fresh?: boolean;
  onUpdate?: (
    value: { items: Entry[]; nextCursor: string | null },
    scope: ApiAuthorizationScope,
  ) => void | Promise<void>;
  onBackgroundError?: (failure: unknown, scope: ApiAuthorizationScope) => void | Promise<void>;
} = {}) {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (limit !== undefined) query.set('limit', String(limit));
  const path = `/entries?${query}`;
  const clearIncompleteList = () => invalidateEntryReadCache('entries');
  if (signal?.aborted) {
    if (cursor) clearIncompleteList();
    signal.throwIfAborted();
  }
  if (cursor) signal?.addEventListener('abort', clearIncompleteList, { once: true });
  try {
    signal?.throwIfAborted();
    const scope = await getApiAuthorizationScope();
    const { retentionDays } = await getClientConfig();
    signal?.throwIfAborted();
    return await readCachedEntry<{ items: Entry[]; nextCursor: string | null }>(
      'entries',
      scope,
      path,
      { signal, fresh, onUpdate, onBackgroundError },
      retentionDays,
    );
  } finally {
    if (cursor) signal?.removeEventListener('abort', clearIncompleteList);
  }
}

export type CreateEntryInput = {
  createRequestId: string;
  diaryDate: string;
  body: string;
  consentVersion: 'v1';
};

const pendingCreateKey = 'manga-nikki.pending-entry-create';
type PendingCreateRequest = { requestId: string; fingerprint: string };

function readPendingCreateRequests(): PendingCreateRequest[] {
  try {
    const stored = sessionStorage.getItem(pendingCreateKey);
    if (!stored) return [];
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return [];
    if ('pending' in value && Array.isArray(value.pending)) {
      return value.pending.filter(
        (item): item is PendingCreateRequest =>
          typeof item === 'object' &&
          item !== null &&
          'requestId' in item &&
          typeof item.requestId === 'string' &&
          'fingerprint' in item &&
          typeof item.fingerprint === 'string',
      );
    }
    if (
      'requestId' in value &&
      typeof value.requestId === 'string' &&
      'fingerprint' in value &&
      typeof value.fingerprint === 'string'
    ) {
      return [{ requestId: value.requestId, fingerprint: value.fingerprint }];
    }
  } catch {
    // Ignore malformed or inaccessible session storage.
  }
  return [];
}

function writePendingCreateRequests(pending: PendingCreateRequest[]) {
  try {
    if (pending.length === 0) sessionStorage.removeItem(pendingCreateKey);
    else sessionStorage.setItem(pendingCreateKey, JSON.stringify({ version: 1, pending }));
  } catch {
    // The request can still proceed without reload-safe retry if storage is unavailable.
  }
}

async function fingerprintPayload(payload: {
  diaryDate: string;
  body: string;
  consentVersion: 'v1';
}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Keeps the create request ID across a reload so a lost response can be retried
 * without creating a duplicate diary. A changed payload receives a new ID.
 */
export async function createEntry(
  input: CreateEntryInput,
  hooks: { onRequestStart?: () => void } = {},
): Promise<Entry> {
  const payload = {
    diaryDate: input.diaryDate,
    body: input.body,
    consentVersion: input.consentVersion,
  };
  let requestId = input.createRequestId;
  let fingerprint: string | null = null;
  try {
    fingerprint = await fingerprintPayload(payload);
  } catch {
    // Continue without reload-safe retry if Web Crypto is unavailable.
  }

  if (fingerprint !== null) {
    const pending = readPendingCreateRequests();
    const previous = pending.find((item) => item.fingerprint === fingerprint);
    if (previous) requestId = previous.requestId;
    else {
      if (pending.length > 0) requestId = crypto.randomUUID();
      pending.push({ requestId, fingerprint });
    }
    writePendingCreateRequests(pending);
  }

  try {
    const entry = await api<Entry>(
      '/entries',
      {
        method: 'POST',
        body: JSON.stringify({ ...payload, createRequestId: requestId }),
      },
      hooks,
    );
    if (fingerprint !== null) {
      const pending = readPendingCreateRequests().filter(
        (item) => item.fingerprint !== fingerprint || item.requestId !== requestId,
      );
      writePendingCreateRequests(pending);
    }
    return entry;
  } catch (error) {
    if (
      fingerprint !== null &&
      error instanceof ApiClientError &&
      error.status === 404 &&
      error.code === 'NOT_FOUND'
    ) {
      const pending = readPendingCreateRequests();
      const index = pending.findIndex(
        (item) => item.fingerprint === fingerprint && item.requestId === requestId,
      );
      const staleRequest = pending[index];
      if (staleRequest) {
        pending[index] = { ...staleRequest, requestId: crypto.randomUUID() };
        writePendingCreateRequests(pending);
      }
    }
    throw error;
  }
}
