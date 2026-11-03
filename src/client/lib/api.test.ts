import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError, generate } from './api';
import { invalidateClientConfig } from './config';

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

afterEach(() => vi.unstubAllGlobals());

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

  it('preserves actionable API messages', async () => {
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
      message: '記録が更新されています。',
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
  });

  it('blocks generation in live mode before sending an empty generation CAPTCHA', async () => {
    invalidateClientConfig();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...mockConfig, dataMode: 'live', generationAvailable: true }),
        ),
    );
    const entry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
    } as Parameters<typeof generate>[0];

    await expect(generate(entry)).rejects.toMatchObject({
      code: 'GENERATION_CAPTCHA_UNAVAILABLE',
      status: 503,
    });
  });

  it('does not use mock auth or make personal requests in sample mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...mockConfig, dataMode: 'sample', generationAvailable: false }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/entries')).rejects.toMatchObject({ code: 'SAMPLE_ONLY', status: 503 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/config', { cache: 'no-store' });
  });
});

describe('diary creation retry', () => {
  it('reuses the same request ID after a reload when the first response is lost', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { createEntry } = await import('./api');
    const input = {
      createRequestId: '11111111-1111-4111-8111-111111111111',
      diaryDate: '2026-11-02',
      body: '今日は図書館へ行った。',
      consentVersion: 'v1' as const,
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        Response.json({
          id: '22222222-2222-4222-8222-222222222222',
          diaryDate: input.diaryDate,
          body: input.body,
          revision: 1,
          latestGenerationId: null,
          createdAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntry(input)).rejects.toThrow('通信に失敗しました');
    expect(values.get('manga-nikki.pending-entry-create')).not.toContain(input.body);
    // A remounted form has a new in-memory ID, but the pending request is reused.
    await createEntry({ ...input, createRequestId: '33333333-3333-4333-8333-333333333333' });

    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(first.createRequestId).toBe(input.createRequestId);
    expect(second.createRequestId).toBe(first.createRequestId);
    expect(values.has('manga-nikki.pending-entry-create')).toBe(false);
  });

  it('uses a new request ID when the diary content changes', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { createEntry } = await import('./api');
    const base = {
      createRequestId: '11111111-1111-4111-8111-111111111111',
      diaryDate: '2026-11-02',
      body: '最初の日記',
      consentVersion: 'v1' as const,
    };
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntry(base)).rejects.toThrow();
    await expect(createEntry({ ...base, body: '修正した日記' })).rejects.toThrow();

    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(second.createRequestId).not.toBe(first.createRequestId);
  });

  it('restores an earlier pending ID after another payload fails', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { createEntry } = await import('./api');
    const base = {
      createRequestId: '11111111-1111-4111-8111-111111111111',
      diaryDate: '2026-11-02',
      consentVersion: 'v1' as const,
    };
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntry({ ...base, body: 'Aの日記' })).rejects.toThrow();
    await expect(
      createEntry({
        ...base,
        createRequestId: '22222222-2222-4222-8222-222222222222',
        body: 'Bの日記',
      }),
    ).rejects.toThrow();
    await expect(
      createEntry({
        ...base,
        createRequestId: '33333333-3333-4333-8333-333333333333',
        body: 'Aの日記',
      }),
    ).rejects.toThrow();

    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(requests[2].createRequestId).toBe(requests[0].createRequestId);
    expect(requests[1].createRequestId).not.toBe(requests[0].createRequestId);
  });

  it('keeps another pending ID when a different payload succeeds', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { createEntry } = await import('./api');
    const base = {
      createRequestId: '11111111-1111-4111-8111-111111111111',
      diaryDate: '2026-11-02',
      consentVersion: 'v1' as const,
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ id: 'saved-b' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntry({ ...base, body: 'Aの日記' })).rejects.toThrow();
    await createEntry({
      ...base,
      createRequestId: '22222222-2222-4222-8222-222222222222',
      body: 'Bの日記',
    });
    await expect(
      createEntry({
        ...base,
        createRequestId: '33333333-3333-4333-8333-333333333333',
        body: 'Aの日記',
      }),
    ).rejects.toThrow();

    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(requests[2].createRequestId).toBe(requests[0].createRequestId);
    expect(requests[1].createRequestId).not.toBe(requests[0].createRequestId);
  });

  it('continues a legacy pending request and retains it after a 4xx response', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { createEntry } = await import('./api');
    const input = {
      createRequestId: '11111111-1111-4111-8111-111111111111',
      diaryDate: '2026-11-02',
      body: '旧形式の保留日記',
      consentVersion: 'v1' as const,
    };
    const payload = {
      diaryDate: input.diaryDate,
      body: input.body,
      consentVersion: input.consentVersion,
    };
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const fingerprint = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    values.set(
      'manga-nikki.pending-entry-create',
      JSON.stringify({ requestId: '99999999-9999-4999-8999-999999999999', fingerprint }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: '認証が必要です。',
              code: 'AUTH_REQUIRED',
              requestId: 'request',
              retryable: false,
            },
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ id: 'saved-entry' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntry(input)).rejects.toMatchObject({ status: 401 });
    await createEntry({ ...input, createRequestId: '22222222-2222-4222-8222-222222222222' });

    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(requests[0].createRequestId).toBe('99999999-9999-4999-8999-999999999999');
    expect(requests[1].createRequestId).toBe(requests[0].createRequestId);
  });
});
