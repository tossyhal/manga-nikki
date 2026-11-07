export type AssetReadCacheInvalidationReason =
  | 'mutation'
  | 'mutation-finish'
  | 'auth-failure'
  | 'auth-scope-change';

export type AssetReadCacheInvalidation = {
  epoch: number;
  reason: AssetReadCacheInvalidationReason;
};

type Listener = (invalidation: AssetReadCacheInvalidation) => void;

let epoch = 0;
const listeners = new Set<Listener>();

export function getAssetReadCacheEpoch(): number {
  return epoch;
}

export function invalidateAssetReadCache(reason: AssetReadCacheInvalidationReason): void {
  epoch++;
  const invalidation = { epoch, reason };
  for (const listener of listeners) listener(invalidation);
}

export function subscribeAssetReadCacheInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
