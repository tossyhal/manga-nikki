import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAssetReadCache } from './assetReadCacheInvalidation';
import {
  ComicImageCacheInvalidatedError,
  ComicImageGrantExpiredError,
  createComicImageMemoryCache,
  type ComicImageAuthorizationScope,
  type ComicImageGrant,
} from './comicImageMemory';

const scopeA: ComicImageAuthorizationScope = {
  dataMode: 'live',
  authorization: 'Bearer synthetic-owner-a-token',
};
const scopeB: ComicImageAuthorizationScope = {
  dataMode: 'live',
  authorization: 'Bearer synthetic-owner-b-token',
};
const generationId = 'generation-a';

function makeGrant(
  id: string,
  url: string,
  wall: number,
  monotonic: number,
  expiresInMs = 60_000,
): ComicImageGrant {
  return {
    id,
    url,
    expiresAt: new Date(wall + expiresInMs).toISOString(),
    requestedAt: monotonic,
    requestedAtWall: wall,
  };
}

function imageResponse(bytes = 'png-bytes'): Response {
  return new Response(new Blob([bytes], { type: 'image/png' }), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('comic image memory cache', () => {
  it('reuses one image fetch after 16 seconds and after a renewed signed grant', async () => {
    let wall = 1_000_000;
    let monotonic = 100;
    let objectUrlNumber = 0;
    const fetchImage = vi.fn(async () => imageResponse());
    const memory = createComicImageMemoryCache({
      fetchImage,
      createObjectURL: () => `blob:comic-${++objectUrlNumber}`,
      revokeObjectURL: vi.fn(),
      now: () => ({ wall, monotonic }),
    });
    const originalGrant = makeGrant('asset-a', '/signed-a', wall, monotonic);

    const first = await memory.load(scopeA, generationId, originalGrant);
    expect(first).toMatchObject({ url: 'blob:comic-1', cached: true });
    first.release();

    wall += 16_000;
    monotonic += 16_000;
    const afterSixteenSeconds = await memory.load(scopeA, generationId, originalGrant);
    expect(afterSixteenSeconds.url).toBe('blob:comic-1');
    afterSixteenSeconds.release();
    expect(fetchImage).toHaveBeenCalledOnce();

    wall += 40_000;
    monotonic += 40_000;
    await expect(memory.load(scopeA, generationId, originalGrant)).rejects.toBeInstanceOf(
      ComicImageGrantExpiredError,
    );
    const renewedGrant = makeGrant('asset-a', '/signed-b', wall, monotonic);
    const renewed = await memory.load(scopeA, generationId, renewedGrant);
    expect(renewed).toMatchObject({ url: 'blob:comic-1', cached: true });
    expect(fetchImage).toHaveBeenCalledOnce();
    renewed.release();
    memory.dispose();
  });

  it('clears bytes on each observed authorization change, including switching back', async () => {
    const fetchImage = vi.fn(async () => imageResponse());
    const memory = createComicImageMemoryCache({
      fetchImage,
      createObjectURL: vi.fn(() => `blob:comic-${fetchImage.mock.calls.length}`),
      revokeObjectURL: vi.fn(),
    });
    const wall = Date.now();
    const mono = performance.now();

    const first = await memory.load(scopeA, generationId, makeGrant('asset-a', '/a1', wall, mono));
    first.release();
    invalidateAssetReadCache('auth-scope-change');
    const second = await memory.load(scopeB, generationId, makeGrant('asset-a', '/b', wall, mono));
    second.release();
    invalidateAssetReadCache('auth-scope-change');
    const third = await memory.load(scopeA, generationId, makeGrant('asset-a', '/a2', wall, mono));
    third.release();

    expect(fetchImage).toHaveBeenCalledTimes(3);
    memory.dispose();
  });

  it('does not let an invalidated in-flight fetch repopulate the cache', async () => {
    let finishFetch!: (response: Response) => void;
    const fetchImage = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve;
        }),
    );
    const createObjectURL = vi.fn(() => 'blob:late');
    const memory = createComicImageMemoryCache({ fetchImage, createObjectURL });
    const promise = memory.load(
      scopeA,
      generationId,
      makeGrant('asset-a', '/signed-a', Date.now(), performance.now()),
    );
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());

    invalidateAssetReadCache('auth-failure');
    finishFetch(imageResponse());

    await expect(promise).rejects.toBeInstanceOf(ComicImageCacheInvalidatedError);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(memory.getStats()).toMatchObject({ imageCount: 0, bytes: 0, inFlightCount: 0 });
    memory.dispose();
  });

  it('bounds entry count and delays object URL revocation until active leases release', async () => {
    let objectUrlNumber = 0;
    const revokeObjectURL = vi.fn();
    const fetchImage = vi.fn(async () => imageResponse('abc'));
    const memory = createComicImageMemoryCache({
      fetchImage,
      createObjectURL: () => `blob:comic-${++objectUrlNumber}`,
      revokeObjectURL,
      maxCachedImages: 1,
      maxCachedBytes: 3,
    });
    const wall = Date.now();
    const mono = performance.now();
    const first = await memory.load(
      scopeA,
      generationId,
      makeGrant('asset-a', '/signed-a', wall, mono),
    );
    const second = await memory.load(
      scopeA,
      generationId,
      makeGrant('asset-b', '/signed-b', wall, mono),
    );

    expect(memory.getStats()).toMatchObject({ imageCount: 1, bytes: 3 });
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:comic-1');
    first.release();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:comic-1');
    second.release();
    memory.dispose();
  });

  it('makes lease release idempotent while another consumer still uses the object URL', async () => {
    const revokeObjectURL = vi.fn();
    const memory = createComicImageMemoryCache({
      fetchImage: vi.fn(async () => imageResponse()),
      createObjectURL: () => 'blob:shared',
      revokeObjectURL,
    });
    const wall = Date.now();
    const mono = performance.now();
    const grant = makeGrant('asset-a', '/signed-a', wall, mono);
    const first = await memory.load(scopeA, generationId, grant);
    const second = await memory.load(scopeA, generationId, grant);

    first.release();
    first.release();
    invalidateAssetReadCache('mutation');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    memory.dispose();
  });

  it('falls back to the signed URL without caching a failed fetch', async () => {
    const fetchImage = vi.fn(async () => {
      throw new TypeError('CORS unavailable');
    });
    const createObjectURL = vi.fn(() => 'blob:unused');
    const memory = createComicImageMemoryCache({ fetchImage, createObjectURL });
    const grant = makeGrant('asset-a', '/signed-a', Date.now(), performance.now());

    const fallback = await memory.load(scopeA, generationId, grant);
    expect(fallback).toMatchObject({ url: '/signed-a', cached: false });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(memory.getStats()).toMatchObject({ imageCount: 0, bytes: 0 });
    fallback.release();
    memory.dispose();
  });
});
