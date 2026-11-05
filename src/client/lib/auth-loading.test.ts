import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () =>
      Response.json({
        dataMode: 'live',
        generationAvailable: false,
        consentVersion: 'v1',
        retentionDays: 30,
      }),
    ),
  );
});

afterEach(() => {
  vi.doUnmock('@supabase/supabase-js');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('lazy authentication SDK', () => {
  it('initializes one client when session checks start concurrently', async () => {
    const getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: { access_token: 'synthetic.jwt' } }, error: null });
    const signInAnonymously = vi.fn();
    const createClient = vi.fn().mockReturnValue({ auth: { getSession, signInAnonymously } });
    vi.doMock('@supabase/supabase-js', () => ({ createClient }));
    const { getLiveAccessToken } = await import('./auth');

    await expect(Promise.all([getLiveAccessToken(), getLiveAccessToken()])).resolves.toEqual([
      'synthetic.jwt',
      'synthetic.jwt',
    ]);
    expect(createClient).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('rejects SDK load failures instead of treating them as a missing session', async () => {
    vi.doMock('@supabase/supabase-js', () => {
      throw new Error('synthetic SDK load failure');
    });
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { removeItem });
    const { ClientAuthError, getLiveAccessToken, registerAnonymousSession } =
      await import('./auth');

    await expect(getLiveAccessToken()).rejects.toBeInstanceOf(ClientAuthError);
    await expect(registerAnonymousSession('synthetic-registration-token')).rejects.toBeInstanceOf(
      ClientAuthError,
    );
    expect(removeItem).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/v1/config', { cache: 'no-store' });
  });
});
