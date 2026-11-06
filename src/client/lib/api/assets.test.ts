import { describe, expect, it, vi } from 'vitest';
import { createAssetUrlLoader } from './assets';
import type { ApiAuthorizationScope } from './client';

const sessionA: ApiAuthorizationScope = {
  dataMode: 'live',
  authorization: 'Bearer synthetic-owner-a-token',
};
const sessionB: ApiAuthorizationScope = {
  dataMode: 'live',
  authorization: 'Bearer synthetic-owner-b-token',
};

function assetUrl(url: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return { url, expiresAt };
}

describe('asset URL reuse', () => {
  it('deduplicates an in-flight request for the same asset and session', async () => {
    const getScope = vi.fn().mockResolvedValue(sessionA);
    let resolveRequest!: (value: ReturnType<typeof assetUrl>) => void;
    let notifyRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequest = resolve;
    });
    const request = vi.fn(
      () =>
        new Promise<ReturnType<typeof assetUrl>>((resolve) => {
          resolveRequest = resolve;
          notifyRequest();
        }),
    );
    const load = createAssetUrlLoader({ getScope, request });

    const first = load('asset-a');
    const second = load('asset-a');
    await requestStarted;
    expect(request).toHaveBeenCalledOnce();
    resolveRequest(assetUrl('/asset-a'));
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { url: '/asset-a' },
      { url: '/asset-a' },
    ]);
  });

  it('reuses only within the short expiry-aware window and refetches for fresh calls', async () => {
    let wall = 1_000;
    let monotonic = 10;
    const getScope = vi.fn().mockResolvedValue(sessionA);
    let requestNumber = 0;
    const request = vi.fn(() => {
      requestNumber++;
      return Promise.resolve(
        assetUrl(`/signed-${requestNumber}`, new Date(wall + 10_000).toISOString()),
      );
    });
    const load = createAssetUrlLoader({
      getScope,
      request,
      now: () => ({ wall, monotonic }),
    });

    const initial = await load('asset-a');
    await expect(load('asset-a')).resolves.toBe(initial);
    expect(request).toHaveBeenCalledOnce();

    wall += 5_001;
    monotonic += 5_001;
    await load('asset-a');
    expect(request).toHaveBeenCalledTimes(2);

    await load('asset-a', { fresh: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps the reuse bound when the wall clock moves backward', async () => {
    let wall = 100_000;
    let monotonic = 500;
    const request = vi.fn(() =>
      Promise.resolve(assetUrl('/signed', new Date(wall + 60_000).toISOString())),
    );
    const load = createAssetUrlLoader({
      getScope: () => Promise.resolve(sessionA),
      request,
      now: () => ({ wall, monotonic }),
    });

    await load('asset-a');
    wall -= 10 * 60_000;
    monotonic += 15_001;
    await load('asset-a');

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not let a late normal response replace a newer fresh URL', async () => {
    let resolveNormal!: (value: ReturnType<typeof assetUrl>) => void;
    let resolveFresh!: (value: ReturnType<typeof assetUrl>) => void;
    let notifyNormal!: () => void;
    let notifyFresh!: () => void;
    const normalStarted = new Promise<void>((resolve) => {
      notifyNormal = resolve;
    });
    const freshStarted = new Promise<void>((resolve) => {
      notifyFresh = resolve;
    });
    let requestNumber = 0;
    const request = vi.fn(
      () =>
        new Promise<ReturnType<typeof assetUrl>>((resolve) => {
          requestNumber++;
          if (requestNumber === 1) {
            resolveNormal = resolve;
            notifyNormal();
          } else {
            resolveFresh = resolve;
            notifyFresh();
          }
        }),
    );
    const load = createAssetUrlLoader({
      getScope: () => Promise.resolve(sessionA),
      request,
    });

    const normal = load('asset-a');
    await normalStarted;
    const fresh = load('asset-a', { fresh: true });
    await freshStarted;
    resolveFresh(assetUrl('/fresh'));
    await fresh;
    resolveNormal(assetUrl('/normal'));
    await normal;

    await expect(load('asset-a')).resolves.toMatchObject({ url: '/fresh' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('clears reuse when the authorization scope changes, including switching back', async () => {
    let scope = sessionA;
    const getScope = vi.fn(() => Promise.resolve(scope));
    const request = vi.fn((id: string, _scope: ApiAuthorizationScope) =>
      Promise.resolve(assetUrl(`/${id}`)),
    );
    const load = createAssetUrlLoader({ getScope, request });

    await load('asset-a');
    scope = sessionB;
    await load('asset-a');
    scope = sessionA;
    await load('asset-a');

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map((call) => call[1])).toEqual([sessionA, sessionB, sessionA]);
  });

  it('does not cache failures and bounds the number of remembered assets', async () => {
    let attempts = 0;
    const request = vi.fn().mockImplementation((id: string) => {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('temporary failure'));
      return Promise.resolve(assetUrl(`/${id}`));
    });
    const load = createAssetUrlLoader({
      getScope: () => Promise.resolve(sessionA),
      request,
    });

    await expect(load('retryable')).rejects.toThrow('temporary failure');
    await load('retryable');
    expect(request).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 33; index++) await load(`asset-${index}`);
    await load('asset-0');
    expect(request).toHaveBeenCalledTimes(36);
  });
});
