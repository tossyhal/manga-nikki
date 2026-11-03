import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { getBearerToken, verifySupabaseAccessToken } from './auth';
import { mockEnvironment, type Environment } from './mode';
import { createServerRpcClient, createUserSupabaseClient } from './supabase-clients';

const signingKeyId = 'test-signing-key';
let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKey = keyPair.privateKey;
  publicJwk = {
    ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    kid: signingKeyId,
    alg: 'RS256',
    use: 'sig',
  };
});

function liveEnvironment(project = crypto.randomUUID()): Environment {
  return {
    ...mockEnvironment,
    APP_ENV: 'staging',
    DATA_MODE: 'live',
    SUPABASE_URL: `https://${project}.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  };
}

function baseClaims(environment: Environment, changes: Record<string, unknown> = {}) {
  return {
    iss: `${environment.SUPABASE_URL}/auth/v1`,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: crypto.randomUUID(),
    role: 'authenticated',
    ...changes,
  };
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const input = `${encodePart({ alg: 'RS256', typ: 'JWT', kid: signingKeyId })}.${encodePart(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function jwksFetch(environment: Environment, status = 200): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${environment.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
      return new Response('not found', { status: 404 });
    if (status !== 200) return new Response('unavailable', { status });
    return Response.json({ keys: [publicJwk] });
  };
}

async function liveRequest(
  environment: Environment,
  token: string | undefined,
  fetcher: typeof fetch,
) {
  const app = createApp({ authFetch: fetcher });
  return app.request(
    'https://app.example/api/v1/entries',
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    environment,
  );
}

describe('Supabase access token boundary', () => {
  it('accepts a valid Supabase JWT and uses its verified UUID subject', async () => {
    const environment = liveEnvironment();
    const claims = baseClaims(environment);
    const token = await signToken(claims);

    await expect(
      verifySupabaseAccessToken(environment, token, jwksFetch(environment)),
    ).resolves.toBe(claims.sub);
    expect((await liveRequest(environment, token, jwksFetch(environment))).status).toBe(503);
  });

  it('rejects a forged signature and non-Bearer or malformed authorization values', async () => {
    const environment = liveEnvironment();
    const token = await signToken(baseClaims(environment));
    const forged = `${token.slice(0, token.lastIndexOf('.') + 1)}${Buffer.from('forged').toString('base64url')}`;

    expect((await liveRequest(environment, forged, jwksFetch(environment))).status).toBe(401);
    expect((await liveRequest(environment, undefined, jwksFetch(environment))).status).toBe(401);
    expect(() => getBearerToken(`Basic ${token}`)).toThrow();
    expect(() => getBearerToken('Bearer not-a-jwt')).toThrow();
  });

  it('requires the project issuer, authenticated audience, an unexpired token, and a UUID subject', async () => {
    const environment = liveEnvironment();
    const cases = [
      { iss: 'https://other.supabase.co/auth/v1' },
      { aud: 'anon' },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { sub: 'not-a-uuid' },
      { sub: undefined },
    ];

    for (const changes of cases) {
      const token = await signToken(baseClaims(environment, changes));
      expect((await liveRequest(environment, token, jwksFetch(environment))).status).toBe(401);
    }
  });

  it('fails closed with a generic dependency error when the JWKS service is unavailable', async () => {
    const environment = liveEnvironment();
    const token = await signToken(baseClaims(environment));
    const response = await liveRequest(environment, token, jwksFetch(environment, 503));
    const unconfigured = await liveRequest(
      { ...environment, SUPABASE_PUBLISHABLE_KEY: '' },
      token,
      jwksFetch(environment),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(unconfigured.status).toBe(503);
    expect(body).not.toContain(token);
    expect(body).not.toContain('unavailable');
  });

  it('treats a JSON JWKS rate-limit response as a dependency failure', async () => {
    const environment = liveEnvironment();
    const token = await signToken(baseClaims(environment));
    const rateLimitedJwks: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== `${environment.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
        return new Response('not found', { status: 404 });
      return Response.json({ message: 'rate limit exceeded' }, { status: 429 });
    };
    const response = await liveRequest(environment, token, rateLimitedJwks);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(token);
    expect(body).not.toContain('rate limit exceeded');
  });

  it('keeps the incoming JWT on the user read client and out of the secret RPC client', async () => {
    const environment = liveEnvironment();
    const authorizationHeaders: string[] = [];
    const apiKeys: string[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      authorizationHeaders.push(request.headers.get('Authorization') ?? '');
      apiKeys.push(request.headers.get('apikey') ?? '');
      return Response.json([]);
    };
    const userToken = 'signed.user.jwt';
    const userClient = createUserSupabaseClient(environment, userToken, captureFetch);
    await userClient.from('entries').select('id');

    const rpcClient = createServerRpcClient(environment, captureFetch);
    await rpcClient.rpc('create_entry', { p_actor_id: crypto.randomUUID() });

    expect(authorizationHeaders[0]).toBe(`Bearer ${userToken}`);
    expect(apiKeys[0]).toBe(environment.SUPABASE_PUBLISHABLE_KEY);
    expect(authorizationHeaders[1]).not.toBe(`Bearer ${userToken}`);
    expect(apiKeys[1]).toBe(environment.SUPABASE_SECRET_KEY);
  });

  it('keeps sample APIs public only for config and health and refuses personal routes', async () => {
    const environment = {
      ...mockEnvironment,
      APP_ENV: 'production' as const,
      DATA_MODE: 'sample' as const,
    };
    const app = createApp();

    expect((await app.request('https://app.example/api/v1/health', {}, environment)).status).toBe(
      200,
    );
    expect((await app.request('https://app.example/api/v1/config', {}, environment)).status).toBe(
      200,
    );
    expect((await app.request('https://app.example/api/v1/entries', {}, environment)).status).toBe(
      503,
    );
    expect(
      (
        await app.request(
          'https://app.example/api/v1/entries',
          { headers: { Authorization: `Bearer mock:${crypto.randomUUID()}` } },
          environment,
        )
      ).status,
    ).toBe(503);
  });
});
