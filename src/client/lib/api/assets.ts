import { api, getApiAuthorizationScope, type ApiAuthorizationScope } from './client';

type AssetUrlResponse = { url: string; expiresAt: string };

export type AssetUrl = AssetUrlResponse & {
  requestedAt: number;
  requestedAtWall: number;
};

export type GetAssetUrlOptions = { fresh?: boolean };

type AssetUrlLoaderDependencies = {
  getScope: () => Promise<ApiAuthorizationScope>;
  request: (id: string, expectedScope: ApiAuthorizationScope) => Promise<AssetUrlResponse>;
  now?: () => { monotonic: number; wall: number };
};

const reuseWindowMs = 15_000;
const expirySafetyMarginMs = 5_000;
const maxCachedAssets = 32;
const maxInFlightRequests = 32;

function scopeKey(scope: ApiAuthorizationScope): string {
  return `${scope.dataMode}\u0000${scope.authorization}`;
}

export function createAssetUrlLoader({
  getScope,
  request,
  now = () => ({ monotonic: performance.now(), wall: Date.now() }),
}: AssetUrlLoaderDependencies) {
  const cache = new Map<
    string,
    { result: AssetUrl; reuseUntilWall: number; reuseUntilMonotonic: number }
  >();
  const inFlight = new Map<string, Promise<AssetUrl>>();
  const latestRequestByAsset = new Map<string, number>();
  let activeScopeKey: string | null = null;
  let nextRequestId = 0;

  function trimCache() {
    while (cache.size > maxCachedAssets) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) return;
      cache.delete(oldestKey);
    }
  }

  function trimInFlight() {
    while (inFlight.size > maxInFlightRequests) {
      const oldestKey = inFlight.keys().next().value;
      if (oldestKey === undefined) return;
      inFlight.delete(oldestKey);
    }
  }

  function trackLatestRequest(assetKey: string, requestId: number) {
    latestRequestByAsset.delete(assetKey);
    latestRequestByAsset.set(assetKey, requestId);
    while (latestRequestByAsset.size > maxInFlightRequests) {
      const oldestKey = latestRequestByAsset.keys().next().value;
      if (oldestKey === undefined) return;
      latestRequestByAsset.delete(oldestKey);
    }
  }

  return async function loadAssetUrl(
    id: string,
    { fresh = false }: GetAssetUrlOptions = {},
  ): Promise<AssetUrl> {
    const scope = await getScope();
    const currentScopeKey = scopeKey(scope);
    if (activeScopeKey !== currentScopeKey) {
      cache.clear();
      inFlight.clear();
      latestRequestByAsset.clear();
      activeScopeKey = currentScopeKey;
    }

    const currentTime = now();
    for (const [key, cached] of cache) {
      if (
        cached.reuseUntilWall <= currentTime.wall ||
        cached.reuseUntilMonotonic <= currentTime.monotonic
      )
        cache.delete(key);
    }

    const assetKey = `${currentScopeKey}\u0000${id}`;
    if (!fresh) {
      const cached = cache.get(assetKey);
      if (cached) {
        cache.delete(assetKey);
        cache.set(assetKey, cached);
        return cached.result;
      }
    }

    const requestKey = `${assetKey}\u0000${fresh ? 'fresh' : 'normal'}`;
    const existingRequest = inFlight.get(requestKey);
    if (existingRequest) return existingRequest;

    const requestedAt = currentTime.monotonic;
    const requestedAtWall = currentTime.wall;
    const requestId = ++nextRequestId;
    trackLatestRequest(assetKey, requestId);
    const requestPromise = request(id, scope).then((response) => {
      const result = { ...response, requestedAt, requestedAtWall };
      const expiry = Date.parse(response.expiresAt);
      const reuseDuration = Math.min(
        reuseWindowMs,
        expiry - requestedAtWall - expirySafetyMarginMs,
      );
      const reuseUntilWall = requestedAtWall + reuseDuration;
      const reuseUntilMonotonic = requestedAt + reuseDuration;
      const completedAt = now();
      if (
        activeScopeKey === currentScopeKey &&
        latestRequestByAsset.get(assetKey) === requestId &&
        typeof response.url === 'string' &&
        response.url.length > 0 &&
        Number.isFinite(expiry) &&
        reuseDuration > 0 &&
        reuseUntilWall > completedAt.wall &&
        reuseUntilMonotonic > completedAt.monotonic
      ) {
        cache.set(assetKey, { result, reuseUntilWall, reuseUntilMonotonic });
        trimCache();
      }
      return result;
    });
    inFlight.set(requestKey, requestPromise);
    trimInFlight();
    try {
      return await requestPromise;
    } finally {
      if (inFlight.get(requestKey) === requestPromise) inFlight.delete(requestKey);
    }
  };
}

const loadAssetUrl = createAssetUrlLoader({
  getScope: getApiAuthorizationScope,
  request: (id, expectedScope) =>
    api<AssetUrlResponse>(`/assets/${encodeURIComponent(id)}/url`, {}, { expectedScope }),
});

export const getAssetUrl = (id: string, options?: GetAssetUrlOptions) => loadAssetUrl(id, options);
