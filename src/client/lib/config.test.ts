import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientConfig, invalidateClientConfig, refreshClientConfig } from './config';

beforeEach(() => invalidateClientConfig());
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockConfig = {
  generationAvailable: false,
  dataMode: 'mock',
  consentVersion: 'v1',
  retentionDays: 30,
};

describe('public client configuration', () => {
  it('rejects unknown modes and unrecognized fields instead of falling back to mock', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        generationAvailable: true,
        dataMode: 'preview',
        consentVersion: 'v1',
        retentionDays: 30,
        supabaseSecretKey: 'must-not-be-present',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getClientConfig()).rejects.toThrow('INVALID_CONFIG');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries after an initial failure without weakening strict config validation', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json(mockConfig));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getClientConfig()).rejects.toThrow('Failed to fetch');
    await expect(getClientConfig()).resolves.toEqual(mockConfig);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates refresh requests and prevents an older response from replacing the newer one', async () => {
    const initialResponse = deferred<Response>();
    const refreshResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(initialResponse.promise)
      .mockReturnValueOnce(refreshResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    const initial = getClientConfig();
    const refresh = refreshClientConfig();
    expect(refreshClientConfig()).toBe(refresh);
    expect(getClientConfig()).toBe(refresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    refreshResponse.resolve(Response.json({ ...mockConfig, generationAvailable: true }));
    await expect(refresh).resolves.toMatchObject({ generationAvailable: true });
    initialResponse.resolve(Response.json(mockConfig));
    await expect(initial).resolves.toMatchObject({ generationAvailable: true });
    await expect(getClientConfig()).resolves.toMatchObject({ generationAvailable: true });
  });

  it('rejects readers that joined a failed refresh, then serves the last good config', async () => {
    const refreshResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(mockConfig))
      .mockReturnValueOnce(refreshResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    await expect(getClientConfig()).resolves.toEqual(mockConfig);
    const refresh = refreshClientConfig();
    const reader = getClientConfig();
    expect(reader).toBe(refresh);
    refreshResponse.reject(new TypeError('Failed to fetch'));

    await expect(reader).rejects.toThrow('Failed to fetch');
    await expect(getClientConfig()).resolves.toEqual(mockConfig);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
