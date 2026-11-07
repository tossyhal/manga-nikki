import {
  subscribeAssetReadCacheInvalidation,
  type AssetReadCacheInvalidationReason,
} from './assetReadCacheInvalidation';

export type ComicImageAuthorizationScope = {
  dataMode: string;
  authorization: string;
};

export type ComicImageGrant = {
  id: string;
  url: string;
  expiresAt: string;
  requestedAt: number;
  requestedAtWall: number;
};

export type ComicImageLease = {
  url: string;
  cached: boolean;
  invalidate: () => void;
  release: () => void;
};

type Clock = { monotonic: number; wall: number };

type MemoryDependencies = {
  fetchImage?: typeof fetch;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  now?: () => Clock;
  maxCachedImages?: number;
  maxCachedBytes?: number;
  maxInFlightRequests?: number;
  retainForMs?: number;
};

type CachedImage = {
  key: string;
  url: string;
  size: number;
  createdAt: Clock;
  references: number;
  retired: boolean;
  revoked: boolean;
};

type InFlightImage = {
  controller: AbortController;
  epoch: number;
  promise: Promise<CachedImage | null>;
};

const safetyMarginMs = 5_000;
const maxReusableGrantMs = 55_000;
const defaultRetentionMs = 5 * 60_000;
const defaultMaxCachedImages = 32;
const defaultMaxCachedBytes = 32 * 1024 * 1024;
const defaultMaxInFlightRequests = 32;

export class ComicImageGrantExpiredError extends Error {
  constructor() {
    super('The signed image grant is no longer safe to use.');
    this.name = 'ComicImageGrantExpiredError';
  }
}

export class ComicImageCacheInvalidatedError extends Error {
  constructor() {
    super('The image cache was invalidated while the image was loading.');
    this.name = 'ComicImageCacheInvalidatedError';
  }
}

function authorizationKey(scope: ComicImageAuthorizationScope): string {
  return `${scope.dataMode}\u0000${scope.authorization}`;
}

function imageKey(
  scope: ComicImageAuthorizationScope,
  generationId: string,
  assetId: string,
): string {
  return `${authorizationKey(scope)}\u0000${generationId}\u0000${assetId}`;
}

function defaultClock(): Clock {
  return { monotonic: performance.now(), wall: Date.now() };
}

export function comicImageGrantRemainingMs(
  grant: Pick<ComicImageGrant, 'expiresAt' | 'requestedAt' | 'requestedAtWall'>,
  now: Clock = defaultClock(),
): number {
  const expiry = Date.parse(grant.expiresAt);
  const duration = Math.min(maxReusableGrantMs, expiry - grant.requestedAtWall - safetyMarginMs);
  const monotonicElapsed = now.monotonic - grant.requestedAt;
  const wallElapsed = now.wall - grant.requestedAtWall;
  if (
    !Number.isFinite(expiry) ||
    !Number.isFinite(grant.requestedAt) ||
    !Number.isFinite(grant.requestedAtWall) ||
    duration <= 0 ||
    monotonicElapsed < 0
  )
    return 0;
  return Math.max(0, duration - Math.max(monotonicElapsed, Math.max(0, wallElapsed)));
}

function retainedWithinWindow(image: CachedImage, now: Clock, retainForMs: number): boolean {
  const monotonicElapsed = now.monotonic - image.createdAt.monotonic;
  const wallElapsed = now.wall - image.createdAt.wall;
  return (
    monotonicElapsed >= 0 &&
    monotonicElapsed < retainForMs &&
    wallElapsed < retainForMs &&
    wallElapsed > -retainForMs
  );
}

export function createComicImageMemoryCache(dependencies: MemoryDependencies = {}) {
  const fetchImage = dependencies.fetchImage ?? globalThis.fetch.bind(globalThis);
  const createObjectURL =
    dependencies.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL =
    dependencies.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const now = dependencies.now ?? defaultClock;
  const maxCachedImages = dependencies.maxCachedImages ?? defaultMaxCachedImages;
  const maxCachedBytes = dependencies.maxCachedBytes ?? defaultMaxCachedBytes;
  const maxInFlightRequests = dependencies.maxInFlightRequests ?? defaultMaxInFlightRequests;
  const retainForMs = dependencies.retainForMs ?? defaultRetentionMs;
  const cache = new Map<string, CachedImage>();
  const inFlight = new Map<string, InFlightImage>();
  let totalBytes = 0;
  let invalidationEpoch = 0;

  function revokeWhenUnused(image: CachedImage) {
    image.retired = true;
    if (image.references === 0 && !image.revoked) {
      revokeObjectURL(image.url);
      image.revoked = true;
    }
  }

  function removeCachedImage(key: string, image: CachedImage) {
    if (cache.get(key) !== image) return;
    cache.delete(key);
    totalBytes -= image.size;
    revokeWhenUnused(image);
  }

  function clear() {
    invalidationEpoch++;
    for (const request of inFlight.values()) request.controller.abort();
    inFlight.clear();
    for (const [key, image] of cache) removeCachedImage(key, image);
  }

  function trim() {
    while (cache.size > maxCachedImages || totalBytes > maxCachedBytes) {
      const oldest = cache.entries().next().value as [string, CachedImage] | undefined;
      if (!oldest) return;
      removeCachedImage(oldest[0], oldest[1]);
    }
  }

  function retain(image: CachedImage): ComicImageLease {
    image.references++;
    let released = false;
    return {
      url: image.url,
      cached: true,
      invalidate: () => removeCachedImage(image.key, image),
      release: () => {
        if (released) return;
        released = true;
        image.references--;
        if (image.retired && image.references === 0 && !image.revoked) {
          revokeObjectURL(image.url);
          image.revoked = true;
        }
      },
    };
  }

  function getValidCachedImage(key: string): CachedImage | null {
    const image = cache.get(key);
    if (!image) return null;
    const currentTime = now();
    if (!retainedWithinWindow(image, currentTime, retainForMs)) {
      removeCachedImage(key, image);
      return null;
    }
    cache.delete(key);
    cache.set(key, image);
    return image;
  }

  async function fetchAndCache(
    key: string,
    grant: ComicImageGrant,
    epoch: number,
    controller: AbortController,
  ): Promise<CachedImage | null> {
    try {
      const response = await fetchImage(grant.url, {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok || epoch !== invalidationEpoch) return null;
      const blob = await response.blob();
      if (
        epoch !== invalidationEpoch ||
        comicImageGrantRemainingMs(grant, now()) <= 0 ||
        blob.size === 0 ||
        blob.size > maxCachedBytes ||
        !blob.type.toLowerCase().startsWith('image/')
      )
        return null;

      let objectUrl: string;
      try {
        objectUrl = createObjectURL(blob);
      } catch {
        return null;
      }
      const image: CachedImage = {
        key,
        url: objectUrl,
        size: blob.size,
        createdAt: now(),
        references: 0,
        retired: false,
        revoked: false,
      };
      cache.set(key, image);
      totalBytes += image.size;
      trim();
      return cache.get(key) === image ? image : null;
    } catch {
      return null;
    }
  }

  async function load(
    scope: ComicImageAuthorizationScope,
    generationId: string,
    grant: ComicImageGrant,
  ): Promise<ComicImageLease> {
    if (comicImageGrantRemainingMs(grant, now()) <= 0) throw new ComicImageGrantExpiredError();

    const key = imageKey(scope, generationId, grant.id);
    const cached = getValidCachedImage(key);
    if (cached) return retain(cached);

    let request = inFlight.get(key);
    if (!request) {
      if (inFlight.size >= maxInFlightRequests)
        return { url: grant.url, cached: false, invalidate: () => {}, release: () => {} };
      const controller = new AbortController();
      const epoch = invalidationEpoch;
      request = {
        controller,
        epoch,
        promise: fetchAndCache(key, grant, epoch, controller),
      };
      inFlight.set(key, request);
    }

    let image: CachedImage | null;
    try {
      image = await request.promise;
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }

    if (request.epoch !== invalidationEpoch) throw new ComicImageCacheInvalidatedError();
    if (comicImageGrantRemainingMs(grant, now()) <= 0) throw new ComicImageGrantExpiredError();
    if (image && cache.get(key) === image) return retain(image);
    return { url: grant.url, cached: false, invalidate: () => {}, release: () => {} };
  }

  const unsubscribe = subscribeAssetReadCacheInvalidation(
    (_invalidation: { epoch: number; reason: AssetReadCacheInvalidationReason }) => clear(),
  );

  return {
    load,
    clear,
    dispose: () => {
      clear();
      unsubscribe();
    },
    getStats: () => ({ imageCount: cache.size, bytes: totalBytes, inFlightCount: inFlight.size }),
  };
}

const comicImageMemory = createComicImageMemoryCache();

export const loadComicImage = comicImageMemory.load;
