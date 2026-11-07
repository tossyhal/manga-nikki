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

function boundary(
  options: {
    expired?: boolean;
    removeAfterSigning?: boolean;
    liveMockPage?: boolean;
    changeGenerationAfterSigning?: boolean;
    changeMetadataAfterSigning?: boolean;
    invalidAsset?: 'owner' | 'generation' | 'path' | 'media' | 'missing';
    incompleteSigning?: boolean;
    malformedSigning?: boolean;
  } = {},
) {
  const entryReads: URL[] = [];
  const signCalls: { url: URL; apiKey: string; authorization: string; body: unknown }[] = [];
  const batchSignCalls: { url: URL; apiKey: string; authorization: string; body: unknown }[] = [];
  const readCalls: { url: URL; apiKey: string; authorization: string }[] = [];
  const generationReads: URL[] = [];
  const metadataReads: URL[] = [];
  let batchSigningStarted = false;
  const script = scriptSchema.parse(scriptSample);
  const comic = {
    schemaVersion: 1,
    title: script.title,
    panels: script.panels,
    visual: { kind: 'panels', assetIds, textMode: 'external' },
  };
  const mockPageComic = {
    schemaVersion: 1,
    title: script.title,
    panels: script.panels,
    visual: { kind: 'page' as const, assetId: generationId, textMode: 'external' as const },
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
      if (apiKey === 'sb_secret_test') {
        metadataReads.push(url);
        const idFilter = url.searchParams.get('id') ?? '';
        if (idFilter.startsWith('in.(')) {
          const requestedIds = idFilter.slice(4, -1).split(',');
          const rows = requestedIds.map((id) => {
            let mediaType = 'image/png';
            let objectPath = `${ownerId}/${generationId}/${id}.png`;
            let assetOwner = ownerId;
            let assetGeneration = generationId;
            if (options.changeMetadataAfterSigning && batchSigningStarted && id === assetIds[0]) {
              mediaType = 'image/webp';
              objectPath = `${ownerId}/${generationId}/${id}.webp`;
            }
            if (options.invalidAsset === 'owner' && id === assetIds[0])
              assetOwner = '99999999-9999-4999-8999-999999999999';
            if (options.invalidAsset === 'generation' && id === assetIds[0])
              assetGeneration = '99999999-9999-4999-8999-999999999999';
            if (options.invalidAsset === 'path' && id === assetIds[0])
              objectPath = `${ownerId}/${generationId}/unexpected.png`;
            if (options.invalidAsset === 'media' && id === assetIds[0])
              mediaType = 'application/json';
            return {
              id,
              generation_id: assetGeneration,
              owner_id: assetOwner,
              object_path: objectPath,
              media_type: mediaType,
            };
          });
          return Response.json(options.invalidAsset === 'missing' ? rows.slice(0, -1) : rows);
        }
        return Response.json([
          {
            id: assetIds[0],
            generation_id: generationId,
            owner_id: ownerId,
            object_path: `${ownerId}/${generationId}/${assetIds[0]}.png`,
            media_type: 'image/png',
          },
        ]);
      }
      return Response.json(
        tokenOwner === ownerId ? [{ id: assetIds[0], generation_id: generationId }] : [],
      );
    }
    if (url.pathname.endsWith('/rest/v1/generations')) {
      readCalls.push({ url, apiKey, authorization });
      generationReads.push(url);
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
            comic_json:
              options.changeGenerationAfterSigning && batchSigningStarted
                ? { ...comic, title: '漫画を変更しました' }
                : options.liveMockPage
                  ? mockPageComic
                  : comic,
            is_mock: options.liveMockPage ?? false,
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
    if (url.pathname === '/storage/v1/object/sign/comics') {
      const body = (await request.json()) as { expiresIn: number; paths: string[] };
      batchSignCalls.push({ url, apiKey, authorization, body });
      batchSigningStarted = true;
      return Response.json(
        body.paths.map((path, index) => ({
          error: options.incompleteSigning && index === 2 ? 'asset missing' : null,
          path,
          signedURL:
            options.incompleteSigning && index === 2
              ? null
              : options.malformedSigning && index === 2
                ? `/object/sign/wrong-bucket/${path}?token=signed-${index}`
                : `/object/sign/comics/${path}?token=signed-${index}`,
        })),
      );
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
  return {
    authFetch,
    supabaseFetch,
    signCalls,
    batchSignCalls,
    readCalls,
    generationReads,
    metadataReads,
    entryReads,
  };
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

async function generationAssetsRequest(
  app: ReturnType<typeof signedApp>,
  environment: Environment,
  token: string,
) {
  return app.request(
    `https://app.example/api/v1/generations/${generationId}/assets`,
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
    expect(bound.signCalls[0]!.authorization).toBe('');
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

describe('private comic asset URL batch', () => {
  it('keeps the live mock page fixture response shape without signing private assets', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ liveMockPage: true });
    const response = await generationAssetsRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      assets: [{ id: generationId, url: '/sample-comic.svg' }],
    });
    expect(bound.entryReads).toHaveLength(1);
    expect(bound.metadataReads).toHaveLength(0);
    expect(bound.batchSignCalls).toHaveLength(0);
  });

  it('signs all four owned assets in one Storage call and uses seven downstream reads/calls', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary();
    const response = await generationAssetsRequest(signedApp(bound), environment, token);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as {
      assets: { id: string; url: string; expiresAt: string }[];
    };
    expect(body.assets.map((asset) => asset.id)).toEqual(assetIds);
    expect(body.assets.map((asset) => Object.keys(asset).sort())).toEqual(
      assetIds.map(() => ['expiresAt', 'id', 'url']),
    );
    expect(
      body.assets.every((asset) => new URL(asset.url).origin === environment.SUPABASE_URL),
    ).toBe(true);
    expect(body.assets.every((asset) => Date.parse(asset.expiresAt) - Date.now() <= 60_000)).toBe(
      true,
    );
    expect(bound.generationReads).toHaveLength(2);
    expect(bound.entryReads).toHaveLength(2);
    expect(bound.metadataReads).toHaveLength(2);
    expect(bound.metadataReads.every((url) => url.searchParams.get('id')?.startsWith('in.('))).toBe(
      true,
    );
    expect(bound.batchSignCalls).toHaveLength(1);
    expect(bound.batchSignCalls[0]!.body).toEqual({
      expiresIn: 60,
      paths: assetIds.map((id) => `${ownerId}/${generationId}/${id}.png`),
    });
    expect(bound.batchSignCalls[0]!.apiKey).toBe('sb_secret_test');
    expect(bound.batchSignCalls[0]!.authorization).toBe('');
    expect(bound.readCalls).toHaveLength(4);
    expect(bound.readCalls.length + bound.entryReads.length + bound.batchSignCalls.length).toBe(7);
    const timing = response.headers.get('Server-Timing') ?? '';
    expect(timing).toMatch(/^auth;dur=\d+\.\d, app;dur=\d+\.\d$/);
    expect(timing).not.toContain(generationId);
    expect(timing).not.toContain(assetIds[0]!);
  });

  it('returns the same 404 for another owner without reading private metadata or signing', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment, '99999999-9999-4999-8999-999999999999');
    const bound = boundary();
    const response = await generationAssetsRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(404);
    expect(bound.metadataReads).toHaveLength(0);
    expect(bound.batchSignCalls).toHaveLength(0);
  });

  it('does not sign assets for an expired entry or missing asset metadata', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const expired = boundary({ expired: true });
    const expiredResponse = await generationAssetsRequest(signedApp(expired), environment, token);
    expect(expiredResponse.status).toBe(404);
    expect(expired.batchSignCalls).toHaveLength(0);

    const incomplete = boundary({ invalidAsset: 'missing' });
    const incompleteResponse = await generationAssetsRequest(
      signedApp(incomplete),
      environment,
      token,
    );
    expect(incompleteResponse.status).toBe(404);
    expect(incomplete.batchSignCalls).toHaveLength(0);
  });

  it.each(['owner', 'generation', 'path', 'media'] as const)(
    'rejects metadata with an unexpected %s before signing',
    async (invalidAsset) => {
      const environment = liveEnvironment();
      const token = await accessToken(environment);
      const bound = boundary({ invalidAsset });
      const response = await generationAssetsRequest(signedApp(bound), environment, token);
      expect(response.status).toBe(404);
      expect(bound.batchSignCalls).toHaveLength(0);
    },
  );

  it('withholds every URL when the entry is deleted while signing', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ removeAfterSigning: true });
    const response = await generationAssetsRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(404);
    expect(bound.batchSignCalls).toHaveLength(1);
    expect(await response.json()).not.toHaveProperty('assets');
  });

  it.each(['generation', 'metadata'] as const)(
    'withholds every URL if %s changes while signing',
    async (changed) => {
      const environment = liveEnvironment();
      const token = await accessToken(environment);
      const bound = boundary(
        changed === 'generation'
          ? { changeGenerationAfterSigning: true }
          : { changeMetadataAfterSigning: true },
      );
      const response = await generationAssetsRequest(signedApp(bound), environment, token);
      expect(response.status).toBe(404);
      expect(bound.batchSignCalls).toHaveLength(1);
      expect(await response.json()).not.toHaveProperty('assets');
    },
  );

  it('withholds a partial Storage signing result', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ incompleteSigning: true });
    const response = await generationAssetsRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('assets');
  });

  it('withholds URLs when Storage returns a signed URL for the wrong bucket path', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const bound = boundary({ malformedSigning: true });
    const response = await generationAssetsRequest(signedApp(bound), environment, token);
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('assets');
  });
});
