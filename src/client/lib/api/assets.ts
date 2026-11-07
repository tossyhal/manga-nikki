import { api, getApiAuthorizationScope, type ApiAuthorizationScope } from './client';
import { getAssetReadCacheEpoch } from './assetReadCacheInvalidation';
import { loadComicImage, type ComicImageLease } from './comicImageMemory';

type AssetUrlResponse = { url: string; expiresAt: string };
type GenerationAssetUrlResponse = AssetUrlResponse & { id: string };

export type AssetUrl = AssetUrlResponse & {
  requestedAt: number;
  requestedAtWall: number;
};

export type GenerationAssetUrl = AssetUrl & { id: string };

export type GenerationAssetUrls = {
  assets: GenerationAssetUrl[];
  loadImage: (assetId: string) => Promise<ComicImageLease>;
};

export type GetAssetUrlOptions = { fresh?: boolean };

type AssetUrlLoaderDependencies = {
  getScope: () => Promise<ApiAuthorizationScope>;
  request: (id: string, expectedScope: ApiAuthorizationScope) => Promise<AssetUrlResponse>;
  now?: () => { monotonic: number; wall: number };
};

type GenerationAssetUrlLoaderDependencies = {
  getScope: () => Promise<ApiAuthorizationScope>;
  request: (
    generationId: string,
    expectedScope: ApiAuthorizationScope,
  ) => Promise<{ assets: GenerationAssetUrlResponse[] }>;
  loadImage?: (
    scope: ApiAuthorizationScope,
    generationId: string,
    grant: GenerationAssetUrl,
  ) => Promise<ComicImageLease>;
  now?: () => { monotonic: number; wall: number };
};

const reuseWindowMs = 55_000;
const expirySafetyMarginMs = 5_000;
const maxCachedAssets = 32;
const maxInFlightRequests = 32;

function scopeKey(scope: ApiAuthorizationScope): string {
  return `${scope.dataMode}\u0000${scope.authorization}`;
}

function reuseDuration(urls: AssetUrl[], requestedAtWall: number): number {
  if (urls.length === 0) return 0;
  return urls.reduce((duration, asset) => {
    const expiry = Date.parse(asset.expiresAt);
    if (!Number.isFinite(expiry) || !asset.url) return 0;
    return Math.min(duration, expiry - requestedAtWall - expirySafetyMarginMs);
  }, reuseWindowMs);
}

function isStillReusable(
  reuseUntilWall: number,
  reuseUntilMonotonic: number,
  currentTime: { monotonic: number; wall: number },
): boolean {
  return reuseUntilWall > currentTime.wall && reuseUntilMonotonic > currentTime.monotonic;
}

function invalidatedRequestError(): Error {
  return new Error('Signed image metadata became invalid before the request completed.');
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
  let seenInvalidationEpoch = getAssetReadCacheEpoch();
  let scopeTransitionEpoch = 0;

  function clear() {
    cache.clear();
    inFlight.clear();
    latestRequestByAsset.clear();
    scopeTransitionEpoch++;
  }

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
    if (getAssetReadCacheEpoch() !== seenInvalidationEpoch) {
      clear();
      seenInvalidationEpoch = getAssetReadCacheEpoch();
    }
    if (activeScopeKey !== currentScopeKey) {
      clear();
      activeScopeKey = currentScopeKey;
    }

    const currentTime = now();
    for (const [key, cached] of cache) {
      if (!isStillReusable(cached.reuseUntilWall, cached.reuseUntilMonotonic, currentTime))
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
    const capturedScopeTransitionEpoch = scopeTransitionEpoch;
    const capturedInvalidationEpoch = getAssetReadCacheEpoch();
    trackLatestRequest(assetKey, requestId);
    const requestPromise = request(id, scope).then((response) => {
      const result = { ...response, requestedAt, requestedAtWall };
      const duration = reuseDuration([result], requestedAtWall);
      const reuseUntilWall = requestedAtWall + duration;
      const reuseUntilMonotonic = requestedAt + duration;
      const completedAt = now();
      if (
        scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
        getAssetReadCacheEpoch() !== capturedInvalidationEpoch
      )
        throw invalidatedRequestError();
      if (
        activeScopeKey === currentScopeKey &&
        latestRequestByAsset.get(assetKey) === requestId &&
        duration > 0 &&
        isStillReusable(reuseUntilWall, reuseUntilMonotonic, completedAt)
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

export function createGenerationAssetUrlLoader({
  getScope,
  request,
  loadImage = loadComicImage,
  now = () => ({ monotonic: performance.now(), wall: Date.now() }),
}: GenerationAssetUrlLoaderDependencies) {
  const cache = new Map<
    string,
    {
      assets: GenerationAssetUrl[];
      requestId: number;
      reuseUntilWall: number;
      reuseUntilMonotonic: number;
    }
  >();
  const inFlight = new Map<string, Promise<{ assets: GenerationAssetUrl[]; requestId: number }>>();
  const latestRequestByGeneration = new Map<string, number>();
  let activeScopeKey: string | null = null;
  let seenInvalidationEpoch = getAssetReadCacheEpoch();
  let scopeTransitionEpoch = 0;
  let nextRequestId = 0;

  function clear() {
    cache.clear();
    inFlight.clear();
    latestRequestByGeneration.clear();
    scopeTransitionEpoch++;
  }

  function trimCache() {
    while (cache.size > maxCachedAssets) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest && latestRequestByGeneration.get(oldestKey) === oldest.requestId)
        latestRequestByGeneration.delete(oldestKey);
    }
  }

  function makeResult(
    generationId: string,
    assets: GenerationAssetUrl[],
    requestId: number,
    expectedScope: ApiAuthorizationScope,
    capturedScopeTransitionEpoch: number,
    capturedInvalidationEpoch: number,
  ): GenerationAssetUrls {
    return {
      assets,
      loadImage: async (assetId: string) => {
        if (
          scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
          getAssetReadCacheEpoch() !== capturedInvalidationEpoch ||
          latestRequestByGeneration.get(`${scopeKey(expectedScope)}\u0000${generationId}`) !==
            requestId
        )
          throw invalidatedRequestError();
        const grant = assets.find((asset) => asset.id === assetId);
        if (!grant) throw new Error('The requested comic image is missing from the generation.');
        const currentScope = await getScope();
        if (scopeKey(currentScope) !== scopeKey(expectedScope)) throw invalidatedRequestError();
        if (
          scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
          getAssetReadCacheEpoch() !== capturedInvalidationEpoch ||
          latestRequestByGeneration.get(`${scopeKey(expectedScope)}\u0000${generationId}`) !==
            requestId
        )
          throw invalidatedRequestError();
        const lease = await loadImage(expectedScope, generationId, grant);
        try {
          const verifiedScope = await getScope();
          if (
            scopeKey(verifiedScope) !== scopeKey(expectedScope) ||
            scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
            getAssetReadCacheEpoch() !== capturedInvalidationEpoch ||
            latestRequestByGeneration.get(`${scopeKey(expectedScope)}\u0000${generationId}`) !==
              requestId
          )
            throw invalidatedRequestError();
          return lease;
        } catch (error) {
          lease.release();
          throw error;
        }
      },
    };
  }

  return async function loadGenerationAssetUrls(
    generationId: string,
    { fresh = false }: GetAssetUrlOptions = {},
  ): Promise<GenerationAssetUrls> {
    const expectedScope = await getScope();
    const currentScopeKey = scopeKey(expectedScope);
    if (getAssetReadCacheEpoch() !== seenInvalidationEpoch) {
      clear();
      seenInvalidationEpoch = getAssetReadCacheEpoch();
    }
    if (activeScopeKey !== currentScopeKey) {
      clear();
      activeScopeKey = currentScopeKey;
    }
    const capturedScopeTransitionEpoch = scopeTransitionEpoch;
    const capturedInvalidationEpoch = getAssetReadCacheEpoch();
    const currentTime = now();
    for (const [key, cached] of cache) {
      if (!isStillReusable(cached.reuseUntilWall, cached.reuseUntilMonotonic, currentTime))
        cache.delete(key);
    }

    const cacheKey = `${currentScopeKey}\u0000${generationId}`;
    if (!fresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return makeResult(
          generationId,
          cached.assets,
          cached.requestId,
          expectedScope,
          capturedScopeTransitionEpoch,
          capturedInvalidationEpoch,
        );
      }
    }

    const requestKey = `${cacheKey}\u0000${fresh ? 'fresh' : 'normal'}`;
    const existingRequest = inFlight.get(requestKey);
    if (existingRequest) {
      const result = await existingRequest;
      if (
        scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
        getAssetReadCacheEpoch() !== capturedInvalidationEpoch
      )
        throw invalidatedRequestError();
      return makeResult(
        generationId,
        result.assets,
        result.requestId,
        expectedScope,
        capturedScopeTransitionEpoch,
        capturedInvalidationEpoch,
      );
    }

    if (inFlight.size >= maxInFlightRequests)
      throw new Error('Too many comic image grants are loading at once.');

    const requestedAt = currentTime.monotonic;
    const requestedAtWall = currentTime.wall;
    const requestId = ++nextRequestId;
    latestRequestByGeneration.delete(cacheKey);
    latestRequestByGeneration.set(cacheKey, requestId);
    while (latestRequestByGeneration.size > maxInFlightRequests) {
      const oldestKey = latestRequestByGeneration.keys().next().value;
      if (oldestKey === undefined) break;
      latestRequestByGeneration.delete(oldestKey);
      cache.delete(oldestKey);
    }
    const requestPromise = request(generationId, expectedScope).then((response) => {
      const assets = response.assets.map((asset) => ({ ...asset, requestedAt, requestedAtWall }));
      const duration = reuseDuration(assets, requestedAtWall);
      const reuseUntilWall = requestedAtWall + duration;
      const reuseUntilMonotonic = requestedAt + duration;
      const completedAt = now();
      if (
        scopeTransitionEpoch !== capturedScopeTransitionEpoch ||
        getAssetReadCacheEpoch() !== capturedInvalidationEpoch
      )
        throw invalidatedRequestError();
      if (
        duration > 0 &&
        latestRequestByGeneration.get(cacheKey) === requestId &&
        isStillReusable(reuseUntilWall, reuseUntilMonotonic, completedAt) &&
        assets.every(
          (asset) => typeof asset.id === 'string' && asset.id.length > 0 && asset.url.length > 0,
        )
      ) {
        cache.set(cacheKey, { assets, requestId, reuseUntilWall, reuseUntilMonotonic });
        trimCache();
      }
      return { assets, requestId };
    });
    inFlight.set(requestKey, requestPromise);
    try {
      const result = await requestPromise;
      return makeResult(
        generationId,
        result.assets,
        result.requestId,
        expectedScope,
        capturedScopeTransitionEpoch,
        capturedInvalidationEpoch,
      );
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

const loadGenerationAssetUrls = createGenerationAssetUrlLoader({
  getScope: getApiAuthorizationScope,
  request: (generationId, expectedScope) =>
    api<{ assets: GenerationAssetUrlResponse[] }>(
      `/generations/${encodeURIComponent(generationId)}/assets`,
      {},
      { expectedScope },
    ),
});

export const getAssetUrl = (id: string, options?: GetAssetUrlOptions) => loadAssetUrl(id, options);

export const getGenerationAssetUrls = (generationId: string, options?: GetAssetUrlOptions) =>
  loadGenerationAssetUrls(generationId, options);
