import { describe, expect, it } from 'vitest';
import { createSupabaseApiKeyFetch } from './supabase-fetch';

describe('createSupabaseApiKeyFetch', () => {
  it.each(['sb_publishable_test', 'sb_secret_test'])(
    'removes only the new API key bearer fallback for %s',
    async (apiKey) => {
      const requests: Request[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      };
      const wrappedFetch = createSupabaseApiKeyFetch(apiKey, fetcher);

      await wrappedFetch('https://project.supabase.co/rest/v1/entries', {
        headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
      });

      expect(requests[0]?.headers.get('apikey')).toBe(apiKey);
      expect(requests[0]?.headers.get('authorization')).toBeNull();
    },
  );

  it('preserves a user JWT bearer token when the request uses a new API key', async () => {
    const request = new Request('https://project.supabase.co/rest/v1/entries', {
      headers: {
        apikey: 'sb_publishable_test',
        Authorization: 'Bearer signed.user.jwt',
      },
    });
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    };

    await createSupabaseApiKeyFetch('sb_publishable_test', fetcher)(request);

    expect(requests[0]?.headers.get('apikey')).toBe('sb_publishable_test');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer signed.user.jwt');
  });

  it.each(['eyJhbGciOiJub25lIn0.anon', 'eyJhbGciOiJub25lIn0.service_role'])(
    'leaves a legacy JWT key and its bearer header intact',
    async (legacyKey) => {
      const request = new Request('https://project.supabase.co/rest/v1/entries', {
        headers: { apikey: legacyKey, Authorization: `Bearer ${legacyKey}` },
      });
      const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
      const fetcher: typeof fetch = async (input, init) => {
        calls.push([input, init]);
        return Response.json({});
      };

      await createSupabaseApiKeyFetch(legacyKey, fetcher)(request);

      expect(calls).toEqual([[request, undefined]]);
    },
  );

  it.each([
    ['apikey does not match', 'sb_publishable_other', 'Bearer sb_publishable_test'],
    ['bearer does not match', 'sb_publishable_test', 'Bearer another-token'],
  ])('preserves Authorization when %s', async (_label, requestKey, authorization) => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    };

    await createSupabaseApiKeyFetch('sb_publishable_test', fetcher)(
      'https://project.supabase.co/rest/v1/entries',
      { headers: { apikey: requestKey, Authorization: authorization } },
    );

    expect(requests[0]?.headers.get('authorization')).toBe(authorization);
  });

  it('uses init.headers as the Request header override and leaves caller inputs unchanged', async () => {
    const apiKey = 'sb_publishable_test';
    const request = new Request('https://project.supabase.co/rest/v1/entries', {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'x-original': 'request',
      },
    });
    const initHeaders = new Headers({
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      'x-override': 'init',
    });
    const init: RequestInit = { headers: initHeaders, method: 'GET' };
    const fetcher: typeof fetch = async (input, fetchInit) => {
      const outgoing = new Request(input, fetchInit);
      expect(outgoing.headers.get('apikey')).toBe(apiKey);
      expect(outgoing.headers.get('authorization')).toBeNull();
      expect(outgoing.headers.get('x-override')).toBe('init');
      expect(outgoing.headers.has('x-original')).toBe(false);
      expect(outgoing.method).toBe('GET');
      return Response.json({});
    };

    await createSupabaseApiKeyFetch(apiKey, fetcher)(request, init);

    expect(request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(initHeaders.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(request.headers.get('x-original')).toBe('request');
    expect(initHeaders.get('x-override')).toBe('init');
  });

  it('keeps a non-matching init override even when the Request had the API key', async () => {
    const apiKey = 'sb_publishable_test';
    const request = new Request('https://project.supabase.co/rest/v1/entries', {
      headers: { apikey: apiKey },
    });
    const init: RequestInit = {
      headers: { apikey: 'sb_publishable_other', Authorization: `Bearer ${apiKey}` },
    };
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = async (input, fetchInit) => {
      calls.push([input, fetchInit]);
      return Response.json({});
    };

    await createSupabaseApiKeyFetch(apiKey, fetcher)(request, init);

    expect(calls).toEqual([[request, init]]);
  });
});
