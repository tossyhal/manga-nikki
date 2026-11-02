import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError } from './api';
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => crypto.randomUUID(), setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());
describe('API error guidance', () => {
  it('turns network failures into retry guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/entries')).rejects.toThrow(
      '通信に失敗しました。入力内容を保持したまま再操作してください。',
    );
  });
  it('does not expose HTML or JSON parse errors from a failed server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>unavailable</html>', { status: 503 })),
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
      vi.fn().mockResolvedValue(
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
});
