import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedAuth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInAnonymously: vi.fn(),
}));
const createClientMock = vi.hoisted(() => vi.fn());

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

import { registerAnonymousSession } from './auth';
import { api } from './api';
import { invalidateClientConfig } from './config';

const liveConfig = {
  dataMode: 'live',
  generationAvailable: false,
  consentVersion: 'v1',
  retentionDays: 30,
};

function setupFetch() {
  const protectedRequest = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/v1/config') return Response.json(liveConfig);
    return protectedRequest(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, protectedRequest };
}

beforeEach(() => {
  invalidateClientConfig();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key');
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'synthetic-site-key');
  mockedAuth.getSession.mockReset();
  mockedAuth.signInAnonymously.mockReset();
  createClientMock.mockReset().mockReturnValue({ auth: mockedAuth });
  const removeItem = vi.fn();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem,
  });
  setupFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('live anonymous session', () => {
  it('stops when public Supabase settings are missing instead of falling back to mock auth', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    const { protectedRequest } = setupFetch();

    await expect(api('/entries')).rejects.toThrow('Supabaseの公開接続設定がありません');

    expect(protectedRequest).not.toHaveBeenCalled();
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('reuses the SDK session and sends its JWT as the API bearer token', async () => {
    mockedAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'synthetic.live.jwt' } },
      error: null,
    });
    const { protectedRequest } = setupFetch();

    await api('/entries');

    expect(mockedAuth.getSession).toHaveBeenCalledOnce();
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();
    const [, init] = protectedRequest.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic.live.jwt');
    expect(createClientMock).toHaveBeenCalledWith(
      'https://synthetic.supabase.co',
      'synthetic-publishable-key',
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      },
    );
  });

  it('stops on refresh failure without clearing local state or creating a new user', async () => {
    mockedAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'stale.jwt' } },
      error: new Error('synthetic refresh failure'),
    });
    const { protectedRequest } = setupFetch();

    await expect(api('/entries')).rejects.toThrow('匿名セッションを確認できません');

    expect(protectedRequest).not.toHaveBeenCalled();
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('does not create a session for an API call when none exists', async () => {
    mockedAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { protectedRequest } = setupFetch();

    await expect(api('/entries')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });

    expect(protectedRequest).not.toHaveBeenCalled();
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('does not create another anonymous user after an API 401', async () => {
    mockedAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'rejected.live.jwt' } },
      error: null,
    });
    const { protectedRequest } = setupFetch();
    protectedRequest.mockResolvedValue(
      Response.json(
        {
          error: {
            message: '認証情報を確認してください。',
            code: 'AUTH_REQUIRED',
            requestId: 'synthetic-request',
            retryable: false,
          },
        },
        { status: 401 },
      ),
    );

    await expect(api('/entries')).rejects.toThrow('自動で別アカウントは作成しません');

    expect(protectedRequest).toHaveBeenCalledOnce();
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('requires a CAPTCHA token and suppresses concurrent duplicate registration', async () => {
    await expect(registerAnonymousSession('')).rejects.toThrow('登録用CAPTCHA');
    expect(mockedAuth.signInAnonymously).not.toHaveBeenCalled();

    mockedAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    let releaseSignup!: (value: unknown) => void;
    let markSignupStarted!: () => void;
    const signupStarted = new Promise<void>((resolve) => {
      markSignupStarted = resolve;
    });
    mockedAuth.signInAnonymously.mockImplementation(
      (credentials: { options: { captchaToken: string } }) => {
        markSignupStarted();
        return new Promise((resolve) => {
          releaseSignup = resolve;
          expect(credentials.options.captchaToken).toBe('registration-only-token');
        });
      },
    );

    const first = registerAnonymousSession('registration-only-token');
    await signupStarted;
    const second = registerAnonymousSession('registration-only-token');
    releaseSignup({ data: { session: { access_token: 'new.live.jwt' } }, error: null });

    await expect(Promise.all([first, second])).resolves.toEqual(['new.live.jwt', 'new.live.jwt']);
    expect(mockedAuth.signInAnonymously).toHaveBeenCalledOnce();
  });
});
