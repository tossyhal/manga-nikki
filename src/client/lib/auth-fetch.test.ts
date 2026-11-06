import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateClientConfig } from './config';
import { ClientAuthError, registerAnonymousSession } from './auth';

const liveConfig = {
  dataMode: 'live',
  generationAvailable: false,
  consentVersion: 'v1',
  retentionDays: 30,
};

beforeEach(() => {
  invalidateClientConfig();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_auth_test');
  vi.stubGlobal('localStorage', {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  invalidateClientConfig();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Supabase Auth fetch headers', () => {
  it('sends a new publishable key only through apikey for anonymous signup', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === '/api/v1/config') return Response.json(liveConfig);
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ message: 'fixture signup failure' }, { status: 400 });
    };
    vi.stubGlobal('fetch', fetcher);

    await expect(registerAnonymousSession('synthetic-captcha')).rejects.toBeInstanceOf(
      ClientAuthError,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://synthetic.supabase.co/auth/v1/signup');
    expect(requests[0]?.headers.get('apikey')).toBe('sb_publishable_auth_test');
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  });
});
