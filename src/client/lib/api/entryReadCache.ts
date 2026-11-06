import type { ApiAuthorizationScope } from './client';

type CacheKind = 'entries' | 'entry';
type CacheRecord = {
  value: unknown;
  epoch: number;
  storedAtMonotonic: number;
  storedAtWall: number;
};
type InFlightRecord = { epoch: number; promise: Promise<unknown> };

const cacheTtlMs = 15_000;
const maxEntriesPerKind = 32;
const maxInFlightPerKind = 32;
const entryCaches: Record<CacheKind, Map<string, CacheRecord>> = {
  entries: new Map(),
  entry: new Map(),
};
const inFlightReads: Record<CacheKind, Map<string, InFlightRecord>> = {
  entries: new Map(),
  entry: new Map(),
};
const cacheEpochs: Record<CacheKind, number> = { entries: 0, entry: 0 };

function cacheKey(scope: ApiAuthorizationScope, key: string) {
  return `${scope.dataMode}\u0000${scope.authorization}\u0000${key}`;
}

export function entryReadCacheEpoch(kind: CacheKind) {
  return cacheEpochs[kind];
}

export function getEntryReadCache<T>(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
): { found: true; value: T } | { found: false } {
  const records = entryCaches[kind];
  const recordKey = cacheKey(scope, key);
  const record = records.get(recordKey);
  if (!record) return { found: false };

  const monotonicAge = performance.now() - record.storedAtMonotonic;
  const wallAge = Date.now() - record.storedAtWall;
  if (
    record.epoch !== cacheEpochs[kind] ||
    monotonicAge < 0 ||
    wallAge < 0 ||
    monotonicAge > cacheTtlMs ||
    wallAge > cacheTtlMs
  ) {
    records.delete(recordKey);
    return { found: false };
  }

  records.delete(recordKey);
  records.set(recordKey, record);
  return { found: true, value: record.value as T };
}

export function setEntryReadCache<T>(
  kind: CacheKind,
  scope: ApiAuthorizationScope,
  key: string,
  value: T,
  epoch: number,
) {
  if (epoch !== cacheEpochs[kind]) return;
  const records = entryCaches[kind];
  const recordKey = cacheKey(scope, key);
  records.delete(recordKey);
  records.set(recordKey, {
    value,
    epoch,
    storedAtMonotonic: performance.now(),
    storedAtWall: Date.now(),
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
  epoch: number,
  load: () => Promise<T>,
): Promise<T> {
  if (epoch !== cacheEpochs[kind]) return load();
  const flights = inFlightReads[kind];
  const recordKey = cacheKey(scope, key);
  const existing = flights.get(recordKey);
  if (existing?.epoch === epoch) return existing.promise as Promise<T>;
  if (flights.size >= maxInFlightPerKind) return load();

  const record: InFlightRecord = { epoch, promise: load() };
  flights.set(recordKey, record);
  const remove = () => {
    if (flights.get(recordKey) === record) flights.delete(recordKey);
  };
  void record.promise.then(remove, remove);
  return record.promise as Promise<T>;
}

export function invalidateEntryReadCache(kind?: CacheKind) {
  const kinds = kind ? [kind] : (Object.keys(entryCaches) as CacheKind[]);
  for (const currentKind of kinds) {
    cacheEpochs[currentKind] += 1;
    entryCaches[currentKind].clear();
    inFlightReads[currentKind].clear();
  }
}
