import type { Entry } from '../../../shared/schemas';
import type { ApiAuthorizationScope } from './client';

type CacheKind = 'entries' | 'entry';
type CacheRecord = {
  value: unknown;
  epoch: number;
  keyEpoch: number;
  storedAtMonotonic: number;
  storedAtWall: number;
  maxAgeMs: number;
};
type CacheEpoch = { epoch: number; keyEpoch: number };
type InFlightRecord = { epoch: CacheEpoch; promise: Promise<unknown> };

export const entryReadCacheFreshTtlMs = 15_000;
export const entryReadCacheMaxStaleMs = 60_000;
const maxEntriesPerKind = 32;
const maxInFlightPerKind = 32;
const maxKeyEpochsPerKind = 128;
const entryCaches: Record<CacheKind, Map<string, CacheRecord>> = {
  entries: new Map(),
  entry: new Map(),
};
const inFlightReads: Record<CacheKind, Map<string, InFlightRecord>> = {
  entries: new Map(),
  entry: new Map(),
};
const cacheEpochs: Record<CacheKind, number> = { entries: 0, entry: 0 };
const keyEpochs: Record<CacheKind, Map<string, number>> = {
  entries: new Map(),
  entry: new Map(),
};
const nextKeyEpochs: Record<CacheKind, number> = { entries: 0, entry: 0 };

function cacheKey(scope: ApiAuthorizationScope, key: string) {
  return `${scope.dataMode}\u0000${scope.authorization}\u0000${key}`;
}

function sameEpoch(left: CacheEpoch, right: CacheEpoch) {
  return left.epoch === right.epoch && left.keyEpoch === right.keyEpoch;
}

function trimKeyEpochs(kind: CacheKind) {
  const epochs = keyEpochs[kind];
  if (epochs.size <= maxKeyEpochsPerKind) return;
  for (const key of epochs.keys()) {
    if (epochs.size <= maxKeyEpochsPerKind) break;
    if (entryCaches[kind].has(key) || inFlightReads[kind].has(key)) continue;
    epochs.delete(key);
  }
}

function currentEpoch(kind: CacheKind, recordKey: string): CacheEpoch {
  let keyEpoch = keyEpochs[kind].get(recordKey);
  if (keyEpoch === undefined) {
    keyEpoch = ++nextKeyEpochs[kind];
    keyEpochs[kind].set(recordKey, keyEpoch);
    trimKeyEpochs(kind);
  }
  return {
    epoch: cacheEpochs[kind],
    keyEpoch,
  };
}

export function entryReadCacheEpoch(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
): CacheEpoch {
  return currentEpoch(kind, cacheKey(scope, key));
}

export function isEntryReadCacheEpochCurrent(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
  epoch: CacheEpoch,
) {
  return sameEpoch(epoch, currentEpoch(kind, cacheKey(scope, key)));
}

export function getEntryReadCache<T>(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
): { found: true; value: T; stale: boolean } | { found: false } {
  const records = entryCaches[kind];
  const recordKey = cacheKey(scope, key);
  const record = records.get(recordKey);
  if (!record) return { found: false };

  const epoch = currentEpoch(kind, recordKey);
  const monotonicAge = performance.now() - record.storedAtMonotonic;
  const wallAge = Date.now() - record.storedAtWall;
  const age = Math.max(monotonicAge, wallAge);
  if (
    !sameEpoch({ epoch: record.epoch, keyEpoch: record.keyEpoch }, epoch) ||
    monotonicAge < 0 ||
    wallAge < 0 ||
    age > record.maxAgeMs
  ) {
    records.delete(recordKey);
    return { found: false };
  }

  records.delete(recordKey);
  records.set(recordKey, record);
  return { found: true, value: record.value as T, stale: age > entryReadCacheFreshTtlMs };
}

export function setEntryReadCache<T>(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
  value: T,
  epoch: CacheEpoch,
  maxAgeMs = entryReadCacheMaxStaleMs,
) {
  const records = entryCaches[kind];
  const recordKey = cacheKey(scope, key);
  const current = currentEpoch(kind, recordKey);
  if (!sameEpoch(epoch, current) || maxAgeMs <= 0) return;
  records.delete(recordKey);
  records.set(recordKey, {
    value,
    epoch: epoch.epoch,
    keyEpoch: epoch.keyEpoch,
    storedAtMonotonic: performance.now(),
    storedAtWall: Date.now(),
    maxAgeMs: Math.min(entryReadCacheMaxStaleMs, maxAgeMs),
  });
  while (records.size > maxEntriesPerKind) {
    const oldestKey = records.keys().next().value;
    if (oldestKey === undefined) break;
    records.delete(oldestKey);
  }
}

export function getOrCreateEntryRead<T>(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
  epoch: CacheEpoch,
  load: () => Promise<T>,
): Promise<T> {
  const recordKey = cacheKey(scope, key);
  if (!isEntryReadCacheEpochCurrent(kind, scope, key, epoch)) return load();
  const flights = inFlightReads[kind];
  const existing = flights.get(recordKey);
  if (existing && sameEpoch(existing.epoch, epoch)) return existing.promise as Promise<T>;
  if (flights.size >= maxInFlightPerKind) return load();

  const record: InFlightRecord = { epoch, promise: load() };
  flights.set(recordKey, record);
  const remove = () => {
    if (flights.get(recordKey) === record) flights.delete(recordKey);
  };
  void record.promise.then(remove, remove);
  return record.promise as Promise<T>;
}

export function invalidateEntryReadCacheKey(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
) {
  const recordKey = cacheKey(scope, key);
  keyEpochs[kind].set(recordKey, ++nextKeyEpochs[kind]);
  entryCaches[kind].delete(recordKey);
  inFlightReads[kind].delete(recordKey);
  trimKeyEpochs(kind);
}

export function removeEntryReadCache(kind: CacheKind, scope: ApiAuthorizationScope, key: string) {
  entryCaches[kind].delete(cacheKey(scope, key));
}

function sameEntryRevision(summary: Entry, detail: Entry) {
  return (
    summary.id === detail.id &&
    summary.revision === detail.revision &&
    summary.latestGenerationId === detail.latestGenerationId &&
    summary.updatedAt === detail.updatedAt &&
    summary.body === detail.body &&
    summary.diaryDate === detail.diaryDate
  );
}

export function reconcileEntryDetailsFromList(
  scope: ApiAuthorizationScope,
  items: Entry[],
  completeList: boolean,
) {
  const details = new Map(items.map((entry) => [entry.id, entry]));
  const scopePrefix = `${scope.dataMode}\u0000${scope.authorization}\u0000`;
  const detailCache = entryCaches.entry;
  for (const [recordKey, record] of detailCache) {
    if (!recordKey.startsWith(scopePrefix)) continue;
    const path = recordKey.slice(scopePrefix.length);
    if (!path.startsWith('/entries/')) continue;
    const cached = record.value as Partial<Entry>;
    if (typeof cached.id !== 'string') continue;
    const current = details.get(cached.id);
    if ((current && !sameEntryRevision(current, cached as Entry)) || (!current && completeList)) {
      invalidateEntryReadCacheKey('entry', scope, path);
    }
  }

  const detailFlights = inFlightReads.entry;
  for (const recordKey of [...detailFlights.keys()]) {
    if (!recordKey.startsWith(scopePrefix)) continue;
    const path = recordKey.slice(scopePrefix.length);
    if (!path.startsWith('/entries/')) continue;
    let id: string;
    try {
      id = decodeURIComponent(path.slice('/entries/'.length));
    } catch {
      continue;
    }
    const current = details.get(id);
    const cached = detailCache.get(recordKey)?.value as Partial<Entry> | undefined;
    const matchesCurrent = Boolean(
      current &&
      cached &&
      typeof cached.id === 'string' &&
      sameEntryRevision(current, cached as Entry),
    );
    if ((current && !matchesCurrent) || (!current && completeList))
      invalidateEntryReadCacheKey('entry', scope, path);
  }
}

export function invalidateEntryReadCache(kind?: CacheKind) {
  const kinds = kind ? [kind] : (Object.keys(entryCaches) as CacheKind[]);
  for (const currentKind of kinds) {
    cacheEpochs[currentKind] += 1;
    entryCaches[currentKind].clear();
    inFlightReads[currentKind].clear();
    keyEpochs[currentKind].clear();
  }
}
