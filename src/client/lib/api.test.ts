import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiClientError,
  generate,
  getQuotaForExistingSession,
  recheckGeneration,
} from './api';
import { invalidateClientConfig } from './config';

vi.mock('./auth', () => ({
  ClientAuthError: class ClientAuthError extends Error {},
  getLiveAccessToken: vi.fn().mockResolvedValue(null),
}));

const mockConfig = {
  generationAvailable: true,
  dataMode: 'mock',
  consentVersion: 'v1',
  retentionDays: 30,
};

function mockFetch(request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/v1/config') return Response.json(mockConfig);
    return request(input, init);
  });
}

beforeEach(() => {
  invalidateClientConfig();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const sessionValues = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => sessionValues.get(key) ?? null,
    setItem: (key: string, value: string) => sessionValues.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('API error guidance', () => {
  it('gives retry guidance when public configuration cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(api('/entries')).rejects.toThrow(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
    );
  });

  it('turns network failures into retry guidance', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(api('/entries')).rejects.toThrow(
      '通信に失敗しました。入力内容を保持したまま再操作してください。',
    );
  });

  it('does not expose HTML or JSON parse errors from a failed server', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => Promise.resolve(new Response('<html>unavailable</html>', { status: 503 }))),
    );
    await expect(api('/entries')).rejects.toMatchObject({
      status: 503,
      code: null,
      requestId: null,
      retryable: null,
      message: expect.stringContaining('通信に失敗しました。'),
    });
  });

  it('maps API codes to safe guidance without exposing server messages', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                message: '記録が更新されています。',
                code: 'REVISION_CONFLICT',
                requestId: 'test-request',
                retryable: false,
              },
            },
            { status: 409 },
          ),
        ),
      ),
    );
    const failure = await api('/entries').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiClientError);
    expect(failure).toMatchObject({
      message: '記録が更新されています。最新の内容を読み込んでから操作してください。',
      status: 409,
      code: 'REVISION_CONFLICT',
      requestId: 'test-request',
      retryable: false,
    });
  });

  it('keeps the mock bearer behavior and generation request', async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal('fetch', mockFetch(request));
    const entry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
    } as Parameters<typeof generate>[0];

    await api('/entries');
    await generate(entry);

    expect(request).toHaveBeenCalledTimes(2);
    const [, init] = request.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toMatch(/^Bearer mock:[0-9a-f-]+$/);
    const [generationUrl, generationInit] = request.mock.calls[1] as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(generationUrl).toBe(`/api/v1/entries/${entry.id}/generations`);
    expect((generationInit.headers as Headers).get('Authorization')).toMatch(/^Bearer mock:/);
    expect(generationInit.body).toContain('"captchaToken":""');
    expect((generationInit.headers as Headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses development mock authentication outside Vite dev mode', async () => {
    vi.stubEnv('DEV', false);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(mockConfig));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/entries')).rejects.toMatchObject({
      code: 'MOCK_AUTH_DISABLED',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/config', { cache: 'no-store' });
  });

  it('blocks live generation without a fresh CAPTCHA before sending a personal request', async () => {
    invalidateClientConfig();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...mockConfig, dataMode: 'live', generationAvailable: true }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const entry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
    } as Parameters<typeof generate>[0];

    await expect(generate(entry)).rejects.toMatchObject({
      code: 'CAPTCHA_REQUIRED',
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reuses the same key for receipt checks without a CAPTCHA token', async () => {
    const request = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })),
      );
    vi.stubGlobal('fetch', mockFetch(request));
    const entry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 4,
    } as Parameters<typeof generate>[0];

    await generate(entry);
    await recheckGeneration(entry);

    const first = request.mock.calls[0]?.[1] as RequestInit;
    const second = request.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe(
      new Headers(second.headers).get('Idempotency-Key'),
    );
    expect(JSON.parse(String(second.body))).toEqual({ expectedRevision: 4, captchaToken: '' });
  });

  it('reads quota only from an existing live session', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ remainingToday: 3 }));
    vi.stubGlobal('fetch', mockFetch(request));
    invalidateClientConfig();
    const configResponse = vi
      .fn()
      .mockResolvedValue(Response.json({ ...mockConfig, dataMode: 'live' }));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/config') return configResponse(input, init);
      return request(input, init);
    });

    await expect(getQuotaForExistingSession()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(configResponse).toHaveBeenCalledOnce();
  });

  it('does not use mock auth or make personal requests in sample mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...mockConfig, dataMode: 'sample', generationAvailable: false }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/entries')).rejects.toMatchObject({ code: 'SAMPLE_ONLY', status: 503 });
    await expect(getQuotaForExistingSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/config', { cache: 'no-store' });
  });
});
