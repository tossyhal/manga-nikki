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
