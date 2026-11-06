import scriptSample from '../../docs/contracts/script.example.json';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { scriptSchema } from './ai/script-schema';
import {
  getLiveGenerationQuota,
  LiveGenerationError,
  reserveLiveOpenAIGeneration,
} from './live-generations';
import { mockEnvironment, type Environment } from './mode';

const assetOwnerId = 'aaaaaaaa-1111-4111-8111-111111111111';
const assetGenerationId = 'bbbbbbbb-2222-4222-8222-222222222222';
const assetEntryId = 'cccccccc-3333-4333-8333-333333333333';
const assetIds = [
  'dddddddd-4444-4444-8444-444444444444',
  'eeeeeeee-5555-4555-8555-555555555555',
  'ffffffff-6666-4666-8666-666666666666',
  '11111111-7777-4777-8777-777777777777',
];
const assetSigningKeyId = 'generation-test-signing-key';
let assetPrivateKey: CryptoKey;
let assetPublicJwk: JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };

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
  assetPrivateKey = pair.privateKey;
  assetPublicJwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: assetSigningKeyId,
    alg: 'RS256',
    use: 'sig',
  };
});

function encodeAssetTokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function signedAssetAccessToken(environment: Environment): Promise<string> {
  const claims = {
    iss: `${environment.SUPABASE_URL}/auth/v1`,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: assetOwnerId,
    role: 'authenticated',
  };
  const input = `${encodeAssetTokenPart({ alg: 'RS256', typ: 'JWT', kid: assetSigningKeyId })}.${encodeAssetTokenPart(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    assetPrivateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

describe('live generation RPC errors', () => {
  it('blocks a new disallowed owner before CAPTCHA and reservation but preserves receipts', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      SUPABASE_URL: 'https://generation-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const receipt = {
      generation_id: 'dddddddd-4444-4444-8444-444444444444',
      status: 'queued',
      status_url: '/api/v1/generations/dddddddd-4444-4444-8444-444444444444',
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(null));
    const turnstileFetch = vi.fn<typeof fetch>();
    const context = {
      environment,
      owner: 'aaaaaaaa-1111-4111-8111-111111111111',
      accessToken: 'test-token',
      fetcher,
      turnstileFetch,
    };
    const input = {
      entryId: 'bbbbbbbb-2222-4222-8222-222222222222',
      expectedRevision: 1,
      idempotencyKey: 'cccccccc-3333-4333-8333-333333333333',
      captchaToken: 'test-captcha',
    };
    await expect(reserveLiveOpenAIGeneration(context, input, true, true)).rejects.toMatchObject({
      status: 503,
      code: 'GENERATION_DISABLED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(turnstileFetch).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json(receipt));
    await expect(reserveLiveOpenAIGeneration(context, input, true, true)).resolves.toMatchObject({
      generationId: receipt.generation_id,
    });
    expect(turnstileFetch).not.toHaveBeenCalled();
  });

  it('hides live availability from a disallowed owner even when the DB permits generation', async () => {
    const context = {
      environment: {
        ...mockEnvironment,
        APP_ENV: 'production' as const,
        SUPABASE_URL: 'https://generation-test.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_test',
      },
      owner: 'aaaaaaaa-1111-4111-8111-111111111111',
      accessToken: 'test-token',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          remaining_today: 1,
          active_generation_id: null,
          reset_at: '2026-11-07T00:00:00Z',
          generation_available: true,
          profile_is_mock: false,
        }),
      ),
    };
    await expect(getLiveGenerationQuota(context, true, false)).resolves.toMatchObject({
      generationAvailable: false,
    });
  });

  it('maps a succeeded-revision reservation rejection to a conflict', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      SUPABASE_URL: 'https://generation-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'demo.example',
      OPENAI_API_KEY: 'provider-key-for-test-only',
      GENERATION_QUEUE: queue,
    };
    const rpcCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const name = new URL(request.url).pathname.split('/').at(-1) ?? '';
      rpcCalls.push(name);
      if (name === 'find_generation_receipt') return Response.json(null);
      if (name === 'reserve_openai_generation')
        return Response.json(
          {
            code: 'P0001',
            message: 'REVISION_ALREADY_GENERATED',
            details: null,
            hint: null,
          },
          { status: 400 },
        );
      throw new Error(`unexpected RPC: ${name}`);
    };
    const turnstileFetch: typeof fetch = async () =>
      Response.json({ success: true, action: 'generate', hostname: 'demo.example' });

    await expect(
      reserveLiveOpenAIGeneration(
        {
          environment,
          owner: 'aaaaaaaa-1111-4111-8111-111111111111',
          accessToken: 'test-access-token',
          fetcher,
          turnstileFetch,
        },
        {
          entryId: 'bbbbbbbb-2222-4222-8222-222222222222',
          expectedRevision: 1,
          idempotencyKey: 'cccccccc-3333-4333-8333-333333333333',
          captchaToken: 'test-captcha',
        },
        true,
        true,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_ALREADY_GENERATED',
    } satisfies Partial<LiveGenerationError>);

    expect(rpcCalls).toEqual(['find_generation_receipt', 'reserve_openai_generation']);
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe('live comic asset metadata reads', () => {
  it('starts entry visibility and service asset reads before either read completes', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'mock',
      SUPABASE_URL: 'https://asset-parallel-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const token = await signedAssetAccessToken(environment);
    const assetId = assetIds[0]!;
    const script = scriptSchema.parse(scriptSample);
    const comic = {
      schemaVersion: 1,
      title: script.title,
      panels: script.panels,
      visual: { kind: 'panels', assetIds, textMode: 'external' },
    };
    const startedReads = new Set<string>();
    const completedReads = new Set<string>();
    let markBothReadsStarted!: () => void;
    const bothReadsStarted = new Promise<void>((resolve) => {
      markBothReadsStarted = resolve;
    });
    let releaseReads!: () => void;
    const readsCanComplete = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const holdRead = async (name: string) => {
      startedReads.add(name);
      if (startedReads.size === 2) markBothReadsStarted();
      await readsCanComplete;
      completedReads.add(name);
    };
    const authFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === `${environment.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
        return Response.json({ keys: [assetPublicJwk] });
      if (request.url === `${environment.SUPABASE_URL}/auth/v1/user`)
        return Response.json({
          id: assetOwnerId,
          aud: 'authenticated',
          role: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-01-01T00:00:00.000Z',
        });
      return new Response(null, { status: 404 });
    };
    const supabaseFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const apiKey = request.headers.get('apikey');
      if (url.pathname.endsWith('/rest/v1/assets')) {
        if (apiKey === environment.SUPABASE_SECRET_KEY) {
          await holdRead('service-asset');
          return Response.json([
            {
              id: assetId,
              generation_id: assetGenerationId,
              owner_id: assetOwnerId,
              object_path: `${assetOwnerId}/${assetGenerationId}/${assetId}.png`,
              media_type: 'image/png',
            },
          ]);
        }
        return Response.json([{ id: assetId, generation_id: assetGenerationId }]);
      }
      if (url.pathname.endsWith('/rest/v1/generations')) {
        if (url.searchParams.get('id') !== `eq.${assetGenerationId}`) return Response.json([]);
        return Response.json([
          {
            id: assetGenerationId,
            entry_id: assetEntryId,
            entry_revision: 1,
            status: 'succeeded',
            stage: null,
            comic_json: comic,
            is_mock: false,
          },
        ]);
      }
      if (url.pathname.endsWith('/rest/v1/entries')) {
        await holdRead('entry-visibility');
        return Response.json([{ id: assetEntryId }]);
      }
      if (url.pathname.startsWith('/storage/v1/object/sign/comics/'))
        return Response.json({
          signedURL: `${url.pathname.replace('/storage/v1', '')}?token=signed-test-token`,
        });
      return new Response(null, { status: 404 });
    };
    const app = createApp({ authFetch, supabaseFetch });
    const responsePromise = app.request(
      `https://app.example/api/v1/assets/${assetId}/url`,
      { headers: { Authorization: `Bearer ${token}` } },
      environment,
    );

    const didBothReadsStart = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      void bothReadsStarted.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    const readsCompletedBeforeRelease = [...completedReads];
    releaseReads();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(startedReads).toEqual(new Set(['entry-visibility', 'service-asset']));
    expect(didBothReadsStart).toBe(true);
    expect(readsCompletedBeforeRelease).toEqual([]);
  });
});
