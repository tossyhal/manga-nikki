import { beforeAll, describe, expect, it } from 'vitest';
import scriptSample from '../../docs/contracts/script.example.json';
import { createApp } from './app';
import { scriptSchema } from './ai/script-schema';
import { mockEnvironment, type Environment } from './mode';

const signingKeyId = 'live-asset-test-key';
const ownerId = '33333333-3333-4333-8333-333333333333';
const generationId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const assetIds = [
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0001',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0002',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0003',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0004',
];
let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: signingKeyId,
    alg: 'RS256',
    use: 'sig',
  };
});

function liveEnvironment(): Environment {
  return {
    ...mockEnvironment,
    APP_ENV: 'staging',
    DATA_MODE: 'live',
    AI_MODE: 'live',
    SUPABASE_URL: 'https://asset-url-test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function accessToken(environment: Environment, owner = ownerId): Promise<string> {
  const payload = {
    iss: `${environment.SUPABASE_URL}/auth/v1`,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: owner,
    role: 'authenticated',
  };
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: signingKeyId })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function boundary(options: { expired?: boolean; removeAfterSigning?: boolean } = {}) {
  const entryReads: URL[] = [];
  const signCalls: { url: URL; apiKey: string; authorization: string; body: unknown }[] = [];
  const readCalls: { url: URL; apiKey: string; authorization: string }[] = [];
  const script = scriptSchema.parse(scriptSample);
  const comic = {
    schemaVersion: 1,
    title: script.title,
    panels: script.panels,
    visual: { kind: 'panels', assetIds, textMode: 'external' },
  };
  const authFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith('/auth/v1/.well-known/jwks.json'))
      return Response.json({ keys: [publicJwk] });
    if (request.url.endsWith('/auth/v1/user')) {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
      return Response.json({
        id: payload.sub,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return new Response(null, { status: 404 });
  };

  const supabaseFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const apiKey = request.headers.get('apikey') ?? '';
    const authorization = request.headers.get('Authorization') ?? '';
    const tokenOwner = (() => {
      const token = authorization.replace(/^Bearer /, '');
      try {
        return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub;
      } catch {
        return undefined;
      }
    })();

    if (url.pathname.endsWith('/rest/v1/assets')) {
      readCalls.push({ url, apiKey, authorization });
      if (apiKey === 'sb_secret_test')
        return Response.json([
          {
            id: assetIds[0],
            generation_id: generationId,
            owner_id: ownerId,
            object_path: `${ownerId}/${generationId}/${assetIds[0]}.png`,
            media_type: 'image/png',
          },
        ]);
      return Response.json(
        tokenOwner === ownerId ? [{ id: assetIds[0], generation_id: generationId }] : [],
      );
    }
    if (url.pathname.endsWith('/rest/v1/generations')) {
      readCalls.push({ url, apiKey, authorization });
      if (
        url.searchParams.get('id') === `eq.${generationId}` &&
        url.searchParams.get('owner_id') === `eq.${ownerId}`
      )
        return Response.json([
          {
            id: generationId,
            entry_id: entryId,
            entry_revision: 1,
            status: 'succeeded',
            stage: null,
            comic_json: comic,
            is_mock: false,
          },
        ]);
      return Response.json([]);
    }
    if (url.pathname.endsWith('/rest/v1/entries')) {
      entryReads.push(url);
      if (options.removeAfterSigning && entryReads.length > 1) return Response.json([]);
      if (options.expired || tokenOwner !== ownerId) return Response.json([]);
      return Response.json([{ id: entryId }]);
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/comics/')) {
      signCalls.push({
        url,
        apiKey,
        authorization,
        body: await request.json(),
      });
      return Response.json({
        signedURL: `${url.pathname.replace('/storage/v1', '')}?token=signed-test-token`,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { authFetch, supabaseFetch, signCalls, readCalls, entryReads };
}

function signedApp(bound: ReturnType<typeof boundary>) {
  return createApp({ authFetch: bound.authFetch, supabaseFetch: bound.supabaseFetch });
}

async function assetRequest(
  app: ReturnType<typeof signedApp>,
  environment: Environment,
  token: string,
) {
  return app.request(
    `https://app.example/api/v1/assets/${assetIds[0]}/url`,
    { headers: { Authorization: `Bearer ${token}` } },
    environment,
  );
}

describe('private comic asset URL', () => {
  it('signs only a succeeded comic asset after owner and live-entry checks, with a 60-second TTL', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary();
    const response = await assetRequest(signedApp(bound), environment, token);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; expiresAt: string };
    expect(new URL(body.url).origin).toBe(environment.SUPABASE_URL);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(55_000);
    expect(bound.signCalls).toHaveLength(1);
    expect(bound.signCalls[0]!.body).toEqual({ expiresIn: 60 });
    expect(bound.signCalls[0]!.apiKey).toBe('sb_secret_test');
    expect(bound.signCalls[0]!.authorization).toBe('Bearer sb_secret_test');
    expect(bound.signCalls[0]!.url.pathname).toBe(
      `/storage/v1/object/sign/comics/${ownerId}/${generationId}/${assetIds[0]}.png`,
    );
    expect(bound.entryReads).toHaveLength(2);
  });

  it('returns the same 404 for another owner and does not sign a URL', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment, '99999999-9999-4999-8999-999999999999');
    const bound = boundary();
    const response = await assetRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(404);
    expect(bound.signCalls).toHaveLength(0);
  });

  it('does not issue a URL for an expired entry', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ expired: true });
    const response = await assetRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(404);
    expect(bound.signCalls).toHaveLength(0);
  });

  it('rechecks entry visibility after signing and withholds the issued URL after deletion', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ removeAfterSigning: true });
    const response = await assetRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(404);
    expect(bound.signCalls).toHaveLength(1);
    expect(await response.json()).not.toHaveProperty('url');
  });
});
