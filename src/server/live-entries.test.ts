import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pageComic } from '../shared/fixtures';
import { createApp } from './app';
import type { RecoverGeneratedComic, SaveGeneratedComic } from './generation-save-handler';
import { mockEnvironment, type Environment } from './mode';

const signingKeyId = 'live-api-test-key';
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
    AI_MODE: 'mock',
    SUPABASE_URL: 'https://live-api-test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function accessToken(environment: Environment, owner = crypto.randomUUID()): Promise<string> {
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

type DbRow = Record<string, unknown> & {
  id: string;
  owner_id: string;
  diary_date: string;
  body: string;
  revision: number;
  latest_generation_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  expires_at: string;
};

function entryRow(
  owner: string,
  id: string = crypto.randomUUID(),
  changes: Partial<DbRow> = {},
): DbRow {
  return {
    id,
    owner_id: owner,
    create_request_id: crypto.randomUUID(),
    create_request_hash: 'internal-hash',
    diary_date: '2026-11-01',
    body: '架空のテスト日記',
    revision: 1,
    latest_generation_id: null,
    consent_version: 'v1',
    created_at: '2026-11-01T00:00:00+00:00',
    updated_at: '2026-11-01T00:00:00+00:00',
    deleted_at: null,
    expires_at: '2999-01-01T00:00:00+00:00',
    ...changes,
  };
}

type RpcOverride = { status: number; body: unknown };
function itemAt<T>(items: T[], index: number): T {
  const item = items[index];
  if (!item) throw new Error('Expected captured request');
  return item;
}

function createSupabaseBoundary() {
  const entries: DbRow[] = [];
  const generations: Record<string, unknown>[] = [];
  const rpcCalls: {
    name: string;
    body: Record<string, unknown>;
    apiKey: string;
    authorization: string;
  }[] = [];
  const readCalls: { url: URL; apiKey: string; authorization: string }[] = [];
  const rpcOverrides = new Map<string, RpcOverride>();
  const authRequests: Request[] = [];

  const authFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    authRequests.push(request);
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
    const rpc = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (rpc) {
      const body = (await request.json()) as Record<string, unknown>;
      rpcCalls.push({ name: rpc, body, apiKey, authorization });
      const override = rpcOverrides.get(rpc);
      if (override) return Response.json(override.body, { status: override.status });
      if (rpc === 'request_entry_deletion') return Response.json({ deletionAccepted: true });
      const row = entryRow(String(body.p_actor_id), crypto.randomUUID(), {
        diary_date: String(body.p_diary_date ?? '2026-11-01'),
        body: String(body.p_body ?? '更新後の日記'),
        revision: rpc === 'update_entry' ? Number(body.p_expected_revision) + 1 : 1,
      });
      return Response.json(rpc === 'create_entry' ? row : [row]);
    }

    readCalls.push({ url, apiKey, authorization });
    if (init?.method && init.method !== 'GET') return new Response(null, { status: 405 });
    if (url.pathname.endsWith('/rest/v1/entries')) {
      let rows = [...entries];
      const ownerFilter = url.searchParams.get('owner_id');
      const requestedId = url.searchParams.get('id');
      if (ownerFilter?.startsWith('eq.'))
        rows = rows.filter((row) => row.owner_id === ownerFilter.slice(3));
      if (requestedId?.startsWith('eq.'))
        rows = rows.filter((row) => row.id === requestedId.slice(3));
      if (url.searchParams.get('deleted_at') === 'is.null')
        rows = rows.filter((row) => row.deleted_at === null);
      const expiryFilter = url.searchParams.get('expires_at');
      if (expiryFilter?.startsWith('gt.')) {
        const cutoff = Date.parse(expiryFilter.slice(3));
        rows = rows.filter((row) => Date.parse(row.expires_at) > cutoff);
      }
      const cursor = url.searchParams.get('or');
      if (cursor) {
        const date = cursor.match(/diary_date\.lt\.(\d{4}-\d{2}-\d{2})/)?.[1];
        const id = cursor.match(/id\.lt\.([0-9a-f-]{36})/)?.[1];
        if (date && id)
          rows = rows.filter(
            (row) => row.diary_date < date || (row.diary_date === date && row.id < id),
          );
      }
      rows.sort((a, b) => b.diary_date.localeCompare(a.diary_date) || b.id.localeCompare(a.id));
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      return Response.json(rows.slice(0, limit));
    }
    if (url.pathname.endsWith('/rest/v1/generations')) {
      let rows = [...generations];
      for (const key of ['id', 'entry_id', 'owner_id', 'status'] as const) {
        const filter = url.searchParams.get(key);
        if (filter?.startsWith('eq.')) rows = rows.filter((row) => row[key] === filter.slice(3));
      }
      const revisionFilter = url.searchParams.get('entry_revision');
      if (revisionFilter?.startsWith('lte.')) {
        const revision = Number(revisionFilter.slice(4));
        rows = rows.filter((row) => Number(row.entry_revision) <= revision);
      }
      const order = url.searchParams.get('order');
      if (order) {
        const clauses = order.split(',').map((clause) => {
          const [column, direction] = clause.split('.');
          return { column: column ?? '', direction };
        });
        rows.sort((left, right) => {
          for (const { column, direction } of clauses) {
            const leftValue = String(left[column] ?? '');
            const rightValue = String(right[column] ?? '');
            const orderValue = leftValue.localeCompare(rightValue);
            if (orderValue !== 0) return direction === 'desc' ? -orderValue : orderValue;
          }
          return 0;
        });
      }
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      return Response.json(rows.slice(0, limit));
    }
    return new Response(null, { status: 404 });
  };

  return {
    entries,
    generations,
    rpcCalls,
    readCalls,
    rpcOverrides,
    authRequests,
    authFetch,
    supabaseFetch,
  };
}

function appWith(
  boundary: ReturnType<typeof createSupabaseBoundary>,
  turnstileFetch?: typeof fetch,
  saveGeneratedComic?: SaveGeneratedComic,
  recoverGeneratedComic?: RecoverGeneratedComic,
) {
  return createApp({
    authFetch: boundary.authFetch,
    supabaseFetch: boundary.supabaseFetch,
    turnstileFetch,
    saveGeneratedComic,
    recoverGeneratedComic,
  });
}

async function apiRequest(
  app: ReturnType<typeof appWith>,
  environment: Environment,
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.request(
    `https://app.example/api/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    environment,
  );
}

describe('live diary HTTP API', () => {
  it('creates through the secret RPC client using only the verified subject and whitelists returned columns', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const app = appWith(boundary);
    const input = {
      createRequestId: crypto.randomUUID(),
      diaryDate: '2026-11-01',
      body: '  架空の作成テスト  ',
      consentVersion: 'v1',
    };
    const response = await apiRequest(app, environment, token, '/entries', 'POST', input);
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(result.body).toBe('架空の作成テスト');
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'diaryDate',
        'body',
        'revision',
        'latestGenerationId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('internal-hash');
    expect(boundary.rpcCalls).toHaveLength(1);
    const rpc = itemAt(boundary.rpcCalls, 0);
    expect(rpc.name).toBe('create_entry');
    expect(rpc.body.p_actor_id).toBe(owner);
    expect(rpc.body.p_body).toBe('架空の作成テスト');
    expect(rpc.apiKey).toBe(environment.SUPABASE_SECRET_KEY);
    expect(rpc.authorization).toBe(`Bearer ${environment.SUPABASE_SECRET_KEY}`);
    expect(boundary.readCalls).toHaveLength(0);

    const spoofed = await apiRequest(app, environment, token, '/entries', 'POST', {
      ...input,
      ownerId: crypto.randomUUID(),
    });
    expect(spoofed.status).toBe(400);
    expect(boundary.rpcCalls).toHaveLength(1);
  });

  it('uses the verified JWT on user reads and the secret key only for RPC writes', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    boundary.entries.push(entryRow(owner));
    const app = appWith(boundary);

    expect((await apiRequest(app, environment, token, '/entries')).status).toBe(200);
    const read = itemAt(boundary.readCalls, 0);
    expect(read.apiKey).toBe(environment.SUPABASE_PUBLISHABLE_KEY);
    expect(read.authorization).toBe(`Bearer ${token}`);
    expect(boundary.authRequests.some((request) => request.url.endsWith('/auth/v1/user'))).toBe(
      true,
    );
  });

  it('maps RPC arrays and fixed SQL business errors without exposing database details', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const app = appWith(boundary);
    const id = crypto.randomUUID();
    boundary.rpcOverrides.set('update_entry', {
      status: 200,
      body: [entryRow(owner, id, { body: '改訂済み', revision: 2 })],
    });
    const updated = await apiRequest(app, environment, token, `/entries/${id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: '2026-11-01',
      body: '改訂済み',
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).revision).toBe(2);

    boundary.rpcOverrides.set('update_entry', {
      status: 400,
      body: {
        code: 'P0001',
        message: 'REVISION_CONFLICT',
        details: 'private SQL detail',
        hint: 'secret hint',
      },
    });
    const conflict = await apiRequest(app, environment, token, `/entries/${id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: '2026-11-01',
      body: '競合した改訂',
    });
    const conflictBody = await conflict.text();
    expect(conflict.status).toBe(409);
    expect(conflictBody).toContain('REVISION_CONFLICT');
    expect(conflictBody).not.toContain('P0001');
    expect(conflictBody).not.toContain('private SQL detail');
    expect(conflictBody).not.toContain('secret hint');

    boundary.rpcOverrides.set('update_entry', {
      status: 500,
      body: { code: 'XX000', message: 'database secret text' },
    });
    const unavailable = await apiRequest(app, environment, token, `/entries/${id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: '2026-11-01',
      body: '再度失敗',
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('database secret text');
  });

  it('maps entry creation policy failures to safe HTTP 429 guidance', async () => {
    const environment = liveEnvironment();
    const token = await accessToken(environment);
    const boundary = createSupabaseBoundary();
    const app = appWith(boundary);
    const input = {
      createRequestId: crypto.randomUUID(),
      diaryDate: '2026-11-01',
      body: '架空の作成制限テスト',
      consentVersion: 'v1',
    };

    for (const [databaseCode, apiCode] of [
      ['ENTRY_OWNER_CREATE_LIMIT_REACHED', 'ENTRY_CREATE_RATE_LIMIT_REACHED'],
      ['ENTRY_GLOBAL_CREATE_LIMIT_REACHED', 'ENTRY_CREATE_RATE_LIMIT_REACHED'],
      ['ENTRY_OWNER_RETAINED_LIMIT_REACHED', 'ENTRY_RETAINED_LIMIT_REACHED'],
      ['ENTRY_GLOBAL_RETAINED_LIMIT_REACHED', 'ENTRY_RETAINED_LIMIT_REACHED'],
    ]) {
      boundary.rpcOverrides.set('create_entry', {
        status: 400,
        body: { code: 'P0001', message: databaseCode, details: 'private SQL detail' },
      });
      const response = await apiRequest(app, environment, token, '/entries', 'POST', input);
      const body = await response.json();
      expect(response.status).toBe(429);
      expect(body.error.code).toBe(apiCode);
      expect(body.error.message).not.toContain('private SQL detail');
    }
  });

  it('returns stable descending composite cursor pages and asks PostgREST to filter owner, deleted, and expired rows', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const first = entryRow(owner, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const second = entryRow(owner, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    const third = entryRow(owner, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    const removed = entryRow(owner, crypto.randomUUID(), { deleted_at: '2026-11-01T00:00:00Z' });
    const expired = entryRow(owner, crypto.randomUUID(), { expires_at: '2000-01-01T00:00:00Z' });
    const foreign = entryRow(crypto.randomUUID());
    boundary.entries.push(first, second, third, removed, expired, foreign);
    const app = appWith(boundary);

    const pageOne = await apiRequest(app, environment, token, '/entries?limit=2');
    const resultOne = await pageOne.json();
    expect(resultOne.items.map((entry: { id: string }) => entry.id)).toEqual([first.id, second.id]);
    expect(resultOne.nextCursor).toEqual(expect.any(String));
    expect(resultOne.nextCursor).not.toBe(second.id);

    const read = itemAt(boundary.readCalls, 0);
    expect(read.url.searchParams.get('select')).toBe(
      'id,diary_date,body,revision,latest_generation_id,created_at,updated_at',
    );
    expect(read.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    expect(read.url.searchParams.get('deleted_at')).toBe('is.null');
    expect(read.url.searchParams.get('expires_at')).toMatch(/^gt\./);
    expect(read.url.searchParams.get('order')).toBe('diary_date.desc,id.desc');

    const pageTwo = await apiRequest(
      app,
      environment,
      token,
      `/entries?limit=2&cursor=${encodeURIComponent(resultOne.nextCursor)}`,
    );
    const resultTwo = await pageTwo.json();
    expect(resultTwo.items.map((entry: { id: string }) => entry.id)).toEqual([third.id]);
    expect(resultTwo.nextCursor).toBeNull();
    const secondRead = itemAt(boundary.readCalls, 1);
    expect(secondRead.url.searchParams.get('or')).toContain(`id.lt.${second.id}`);
    expect(secondRead.url.searchParams.get('or')).toContain(`diary_date.eq.${second.diary_date}`);

    const defaultLimit = await apiRequest(app, environment, token, '/entries');
    expect(defaultLimit.status).toBe(200);
    expect(itemAt(boundary.readCalls, 2).url.searchParams.get('limit')).toBe('21');
    const maxLimit = await apiRequest(app, environment, token, '/entries?limit=50');
    expect(maxLimit.status).toBe(200);
    expect(itemAt(boundary.readCalls, 3).url.searchParams.get('limit')).toBe('51');
    const tooMany = await apiRequest(app, environment, token, '/entries?limit=51');
    expect(tooMany.status).toBe(400);

    const malformed = await apiRequest(app, environment, token, '/entries?cursor=not-a-cursor');
    expect(malformed.status).toBe(400);
  });

  it('returns the generation revision after the diary is edited and refuses unknown provenance', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const entry = entryRow(owner, crypto.randomUUID(), { latest_generation_id: generationId });
    boundary.entries.push(entry);
    boundary.generations.push({
      id: generationId,
      entry_id: entry.id,
      owner_id: owner,
      entry_revision: 1,
      idempotency_key: crypto.randomUUID(),
      request_hash: 'internal-request-hash',
      input_snapshot: 'internal-diary-snapshot',
      model_profile_snapshot: { private: true },
      claim_token: crypto.randomUUID(),
      deadline_at: '2026-11-02T00:00:00Z',
      status: 'succeeded',
      stage: null,
      comic_json: pageComic,
      error_code: null,
      is_mock: true,
      created_at: '2026-11-01T00:00:00+00:00',
    });
    boundary.generations.push({
      id: crypto.randomUUID(),
      entry_id: entry.id,
      owner_id: owner,
      entry_revision: 1,
      status: 'succeeded',
      stage: null,
      comic_json: pageComic,
      is_mock: true,
      created_at: '2026-11-03T00:00:00+00:00',
    });
    const app = appWith(boundary);
    boundary.rpcOverrides.set('update_entry', {
      status: 200,
      body: [
        entryRow(owner, entry.id, {
          latest_generation_id: generationId,
          revision: 2,
          body: '編集後の日記',
        }),
      ],
    });
    const updated = await apiRequest(app, environment, token, `/entries/${entry.id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: entry.diary_date,
      body: '編集後の日記',
    });
    const updatedEntry = await updated.json();
    expect(updated.status).toBe(200);
    expect(updatedEntry.revision).toBe(2);
    Object.assign(entry, { revision: updatedEntry.revision, body: updatedEntry.body });

    const response = await apiRequest(app, environment, token, `/entries/${entry.id}`);
    const detail = await response.json();

    expect(response.status).toBe(200);
    expect(detail.revision).toBe(2);
    expect(detail.latestGeneration).toEqual({
      id: generationId,
      entryId: entry.id,
      entryRevision: 1,
      mock: true,
      status: 'succeeded',
      stage: null,
      comic: pageComic,
    });
    expect(detail.lastSuccessfulGeneration).toEqual(detail.latestGeneration);
    expect(JSON.stringify(detail)).not.toContain('internal-diary-snapshot');
    expect(JSON.stringify(detail)).not.toContain('internal-request-hash');
    const generationRead = itemAt(boundary.readCalls, 1);
    expect(generationRead.url.searchParams.get('select')).toBe(
      'id,entry_id,entry_revision,status,stage,comic_json,is_mock',
    );
    expect(generationRead.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    const successfulRead = itemAt(boundary.readCalls, 2);
    expect(successfulRead.url.searchParams.get('entry_id')).toBe(`eq.${entry.id}`);
    expect(successfulRead.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    expect(successfulRead.url.searchParams.get('status')).toBe('eq.succeeded');
    expect(successfulRead.url.searchParams.get('entry_revision')).toBe('lte.2');
    expect(successfulRead.url.searchParams.get('order')).toBe('created_at.desc,id.desc');
    expect(successfulRead.url.searchParams.get('limit')).toBe('1');

    itemAt(boundary.generations, 0).is_mock = null;
    const unknownOrigin = await apiRequest(app, environment, token, `/entries/${entry.id}`);
    expect(unknownOrigin.status).toBe(503);
    expect((await unknownOrigin.json()).error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('maps persisted queued, running, failed, unknown, and cancelled states without inferring source from AI_MODE', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const entry = entryRow(owner, crypto.randomUUID(), { latest_generation_id: generationId });
    boundary.entries.push(entry);
    boundary.generations.push({
      id: generationId,
      entry_id: entry.id,
      owner_id: owner,
      entry_revision: 1,
      status: 'queued',
      stage: null,
      comic_json: null,
      is_mock: true,
    });
    const app = appWith(boundary);
    const states = [
      { status: 'queued', stage: null, comic_json: null },
      { status: 'running', stage: 'images', comic_json: null },
      { status: 'failed', stage: null, comic_json: null },
      { status: 'unknown', stage: null, comic_json: null },
      { status: 'cancelled', stage: null, comic_json: null },
    ] as const;

    for (const state of states) {
      Object.assign(itemAt(boundary.generations, 0), state);
      const response = await apiRequest(app, environment, token, `/entries/${entry.id}`);
      const detail = await response.json();
      expect(response.status).toBe(200);
      expect(detail.latestGeneration.status).toBe(state.status);
      expect(detail.latestGeneration.stage).toBe(state.stage);
      expect(detail.latestGeneration.mock).toBe(true);
      if (state.status === 'unknown') {
        expect(detail.latestGeneration.error.code).toBe('RESULT_UNKNOWN');
        expect(detail.latestGeneration.error.retryable).toBe(false);
      }
    }

    itemAt(boundary.generations, 0).is_mock = false;
    const storedLiveSource = await apiRequest(app, environment, token, `/entries/${entry.id}`);
    expect((await storedLiveSource.json()).latestGeneration.mock).toBe(false);
  });

  it('keeps the latest job separate from the newest eligible saved success', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const entryId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const desiredSuccessId = crypto.randomUUID();
    boundary.entries.push(
      entryRow(owner, entryId, { revision: 2, latest_generation_id: failedId }),
    );
    boundary.generations.push(
      {
        id: failedId,
        entry_id: entryId,
        owner_id: owner,
        entry_revision: 2,
        status: 'failed',
        stage: null,
        comic_json: null,
        is_mock: true,
        created_at: '2026-11-04T00:00:00+00:00',
      },
      {
        id: desiredSuccessId,
        entry_id: entryId,
        owner_id: owner,
        entry_revision: 2,
        status: 'succeeded',
        stage: null,
        comic_json: pageComic,
        is_mock: true,
        created_at: '2026-11-02T00:00:00+00:00',
      },
      {
        id: crypto.randomUUID(),
        entry_id: entryId,
        owner_id: owner,
        entry_revision: 3,
        status: 'succeeded',
        stage: null,
        comic_json: pageComic,
        is_mock: true,
        created_at: '2026-11-06T00:00:00+00:00',
      },
      {
        id: crypto.randomUUID(),
        entry_id: crypto.randomUUID(),
        owner_id: owner,
        entry_revision: 2,
        status: 'succeeded',
        stage: null,
        comic_json: pageComic,
        is_mock: true,
        created_at: '2026-11-07T00:00:00+00:00',
      },
      {
        id: crypto.randomUUID(),
        entry_id: entryId,
        owner_id: crypto.randomUUID(),
        entry_revision: 2,
        status: 'succeeded',
        stage: null,
        comic_json: pageComic,
        is_mock: true,
        created_at: '2026-11-08T00:00:00+00:00',
      },
    );
    const response = await apiRequest(appWith(boundary), environment, token, `/entries/${entryId}`);
    const detail = await response.json();

    expect(response.status).toBe(200);
    expect(detail.latestGenerationId).toBe(failedId);
    expect(detail.latestGeneration.status).toBe('failed');
    expect(detail.lastSuccessfulGeneration.id).toBe(desiredSuccessId);
    expect(detail.lastSuccessfulGeneration.status).toBe('succeeded');
    expect(detail.lastSuccessfulGeneration.entryRevision).toBe(2);
  });

  it('hides another owner’s and expired entries and maps generation dependencies safely', async () => {
    const environment = liveEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const foreign = entryRow(crypto.randomUUID());
    const expired = entryRow(owner, crypto.randomUUID(), { expires_at: '2000-01-01T00:00:00Z' });
    boundary.entries.push(foreign, expired);
    const app = appWith(boundary);

    const missing = await apiRequest(app, environment, token, `/entries/${foreign.id}`);
    expect(missing.status).toBe(404);
    expect(itemAt(boundary.readCalls, 0).url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    const deleted = await apiRequest(
      app,
      environment,
      token,
      `/entries/${crypto.randomUUID()}`,
      'DELETE',
    );
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({ deletionAccepted: true });
    expect(boundary.rpcCalls.at(-1)?.name).toBe('request_entry_deletion');
    expect(boundary.rpcCalls.at(-1)?.body.p_actor_id).toBe(owner);
    expect(boundary.rpcCalls.at(-1)?.apiKey).toBe(environment.SUPABASE_SECRET_KEY);

    const generationId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const quota = await apiRequest(app, environment, token, '/me/quota');
    const generate = await apiRequest(
      app,
      environment,
      token,
      `/entries/${foreign.id}/generations`,
      'POST',
      {},
    );
    const generation = await apiRequest(app, environment, token, `/generations/${generationId}`);
    const asset = await apiRequest(app, environment, token, `/assets/${assetId}/url`);
    expect([quota.status, generate.status, generation.status, asset.status]).toEqual([
      503, 400, 404, 404,
    ]);
  });

  it('returns 503 when RPC configuration is missing and never falls back to the mock repository', async () => {
    const environment = liveEnvironment();
    delete environment.SUPABASE_SECRET_KEY;
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const app = appWith(boundary);
    const response = await apiRequest(app, environment, token, '/entries', 'POST', {
      createRequestId: crypto.randomUUID(),
      diaryDate: '2026-11-01',
      body: '秘密設定がないときの架空入力',
      consentVersion: 'v1',
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(boundary.rpcCalls).toHaveLength(0);
    expect(boundary.readCalls).toHaveLength(0);
  });
});

describe('live generation HTTP API', () => {
  function connectedEnvironment(queue = { send: vi.fn(async () => undefined) }): Environment {
    return {
      ...liveEnvironment(),
      TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'app.example,localhost',
      GENERATION_QUEUE: queue,
    };
  }

  function liveDemoEnvironment(queue = { send: vi.fn(async () => undefined) }): Environment {
    return {
      ...liveEnvironment(),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
      OPENAI_API_KEY: 'openai-test-key',
      TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'app.example,localhost',
      GENERATION_QUEUE: queue,
    };
  }

  it('preserves a live OpenAI receipt while generation is disabled and dependencies are absent', async () => {
    const environment: Environment = {
      ...liveEnvironment(),
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
    };
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const turnstileFetch = vi.fn<typeof fetch>();
    boundary.rpcOverrides.set('find_generation_receipt', {
      status: 200,
      body: {
        generation_id: generationId,
        status: 'running',
        status_url: `/api/v1/generations/${generationId}`,
      },
    });
    const app = appWith(boundary, turnstileFetch);

    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${crypto.randomUUID()}/generations`,
      'POST',
      { expectedRevision: 4, captchaToken: 'expired-token' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );

    expect(response.status).toBe(202);
    expect((await response.json()).generationId).toBe(generationId);
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual(['find_generation_receipt']);
    expect(turnstileFetch).not.toHaveBeenCalled();
  });

  it('reserves OpenAI work only after JWT receipt lookup and Turnstile, then enqueues its ID', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const environment = liveDemoEnvironment(queue);
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const events: string[] = [];
    const authFetch: typeof fetch = async (input, init) => {
      events.push('auth');
      return boundary.authFetch(input, init);
    };
    const supabaseFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const rpcName = new URL(request.url).pathname.match(/\/rpc\/([^/]+)$/)?.[1];
      if (rpcName) events.push(`rpc:${rpcName}`);
      return boundary.supabaseFetch(input, init);
    };
    const turnstileFetch: typeof fetch = async () => {
      events.push('turnstile');
      return Response.json({ success: true, hostname: 'app.example', action: 'generate' });
    };
    queue.send.mockImplementation(async () => {
      events.push('queue');
    });
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    boundary.rpcOverrides.set('reserve_openai_generation', {
      status: 200,
      body: {
        generation_id: generationId,
        status: 'queued',
        status_url: `/api/v1/generations/${generationId}`,
      },
    });
    boundary.rpcOverrides.set('mark_generation_enqueued', { status: 200, body: true });
    const saveGeneratedComic: SaveGeneratedComic = async () => ({
      generationId,
      status: 'succeeded',
    });
    const recoverGeneratedComic: RecoverGeneratedComic = async (requestedId) => ({
      generationId: requestedId,
      status: 'pending',
    });
    const app = createApp({
      authFetch,
      supabaseFetch,
      turnstileFetch,
      saveGeneratedComic,
      recoverGeneratedComic,
    });

    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${entryId}/generations`,
      'POST',
      { expectedRevision: 3, captchaToken: 'fresh-generation-token' },
      { 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      generationId,
      status: 'queued',
      statusUrl: `/api/v1/generations/${generationId}`,
    });
    expect(events.indexOf('auth')).toBeLessThan(events.indexOf('rpc:find_generation_receipt'));
    expect(events).toEqual([
      'auth',
      'rpc:find_generation_receipt',
      'turnstile',
      'rpc:reserve_openai_generation',
      'queue',
      'rpc:mark_generation_enqueued',
    ]);
    expect(
      boundary.rpcCalls.find((call) => call.name === 'reserve_openai_generation')?.body,
    ).toEqual({
      p_actor_id: owner,
      p_entry_id: entryId,
      p_expected_revision: 3,
      p_idempotency_key: idempotencyKey,
      p_generation_enabled: true,
    });
    expect(queue.send).toHaveBeenCalledExactlyOnceWith({ generationId });
  });

  it('replays an existing receipt without checking CAPTCHA or enqueueing again', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const queue = environment.GENERATION_QUEUE as { send: ReturnType<typeof vi.fn> };
    const turnstileFetch = vi.fn<typeof fetch>();
    const app = appWith(boundary, turnstileFetch);
    const generationId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    boundary.rpcOverrides.set('find_generation_receipt', {
      status: 200,
      body: {
        generation_id: generationId,
        status: 'queued',
        status_url: `/api/v1/generations/${generationId}`,
      },
    });

    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${entryId}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'already-used-token' },
      { 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      generationId,
      status: 'queued',
      statusUrl: `/api/v1/generations/${generationId}`,
    });
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual(['find_generation_receipt']);
    expect(turnstileFetch).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('validates the generation-only CAPTCHA, reserves once, and enqueues only the generation ID', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const queue = environment.GENERATION_QUEUE as { send: ReturnType<typeof vi.fn> };
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    boundary.rpcOverrides.set('reserve_mock_generation', {
      status: 200,
      body: {
        generation_id: generationId,
        status: 'queued',
        status_url: `/api/v1/generations/${generationId}`,
      },
    });
    boundary.rpcOverrides.set('mark_generation_enqueued', { status: 200, body: true });
    const turnstileFetch: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      const form = await request.formData();
      expect(new URL(request.url).hostname).toBe('challenges.cloudflare.com');
      expect(form.get('secret')).toBe('turnstile-test-secret');
      expect(form.get('response')).toBe('fresh-generation-token');
      return Response.json({ success: true, hostname: 'app.example', action: 'generate' });
    });
    const app = appWith(boundary, turnstileFetch);

    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${entryId}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
      { 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(202);
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual([
      'find_generation_receipt',
      'reserve_mock_generation',
      'mark_generation_enqueued',
    ]);
    expect(itemAt(boundary.rpcCalls, 1).body).toEqual({
      p_actor_id: owner,
      p_entry_id: entryId,
      p_expected_revision: 1,
      p_idempotency_key: idempotencyKey,
    });
    expect(queue.send).toHaveBeenCalledExactlyOnceWith({ generationId });
    expect(turnstileFetch).toHaveBeenCalledTimes(1);
  });

  it('returns accepted when queue delivery fails so scheduled reconciliation can retry it', async () => {
    const environment = connectedEnvironment({
      send: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    });
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    boundary.rpcOverrides.set('reserve_mock_generation', {
      status: 200,
      body: {
        generation_id: generationId,
        status: 'queued',
        status_url: `/api/v1/generations/${generationId}`,
      },
    });
    const turnstileFetch: typeof fetch = async () =>
      Response.json({ success: true, hostname: 'app.example', action: 'generate' });
    const app = appWith(boundary, turnstileFetch);
    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${crypto.randomUUID()}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );

    expect(response.status).toBe(202);
    expect((await response.json()).generationId).toBe(generationId);
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual([
      'find_generation_receipt',
      'reserve_mock_generation',
    ]);
  });

  it('rejects wrong Turnstile action and hostname and treats outages as 503', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    for (const result of [
      { success: true, hostname: 'app.example', action: 'signup' },
      { success: true, hostname: 'evil.example', action: 'generate' },
    ]) {
      const deniedApp = appWith(boundary, async () => Response.json(result));
      const denied = await apiRequest(
        deniedApp,
        environment,
        token,
        `/entries/${crypto.randomUUID()}/generations`,
        'POST',
        { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
        { 'Idempotency-Key': crypto.randomUUID() },
      );
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe('CAPTCHA_FAILED');
    }
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual([
      'find_generation_receipt',
      'find_generation_receipt',
    ]);

    const unavailable = appWith(boundary, async () => {
      throw new Error('siteverify timeout');
    });
    const failed = await apiRequest(
      unavailable,
      environment,
      token,
      `/entries/${crypto.randomUUID()}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('keeps the Turnstile deadline active while reading the verification response body', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    const stalled = new Response(null);
    stalled.json = () => new Promise<unknown>(() => {});
    let reachedTurnstile: () => void = () => {};
    const turnstileReached = new Promise<void>((resolve) => {
      reachedTurnstile = resolve;
    });
    const turnstileFetch = vi.fn<typeof fetch>(async () => {
      reachedTurnstile();
      return stalled;
    });
    const app = appWith(boundary, turnstileFetch);

    vi.useFakeTimers();
    try {
      const responsePromise = apiRequest(
        app,
        environment,
        token,
        `/entries/${crypto.randomUUID()}/generations`,
        'POST',
        { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
        { 'Idempotency-Key': crypto.randomUUID() },
      );
      await turnstileReached;
      expect(turnstileFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(boundary.rpcCalls.map((call) => call.name)).toEqual(['find_generation_receipt']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns live quota data without exposing policy details and gates actual real generation', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    boundary.rpcOverrides.set('get_generation_quota', {
      status: 200,
      body: {
        remaining_today: 0,
        active_generation_id: null,
        reset_at: '2026-11-04T00:00:00+09:00',
        generation_available: true,
        profile_is_mock: false,
      },
    });
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    const app = appWith(boundary);
    const quota = await apiRequest(app, environment, token, '/me/quota');
    const quotaBody = await quota.json();
    expect(quota.status).toBe(200);
    expect(quotaBody).toEqual({
      remainingToday: 0,
      activeGenerationId: null,
      resetAt: '2026-11-03T15:00:00.000Z',
      generationAvailable: false,
    });
    expect(quotaBody).not.toHaveProperty('profileIsMock');

    const liveDemo: Environment = {
      ...environment,
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'true',
    };
    const entry = entryRow(owner);
    boundary.entries.push(entry);
    const liveDemoApp = appWith(boundary);
    const config = await liveDemoApp.request('https://app.example/api/v1/config', {}, liveDemo);
    expect((await config.json()).generationAvailable).toBe(false);
    const listed = await apiRequest(liveDemoApp, liveDemo, token, '/entries');
    expect(listed.status).toBe(200);
    expect((await listed.json()).items).toMatchObject([{ id: entry.id, body: entry.body }]);
    const saved = await apiRequest(liveDemoApp, liveDemo, token, '/entries', 'POST', {
      createRequestId: crypto.randomUUID(),
      diaryDate: entry.diary_date,
      body: '保存できる架空日記',
      consentVersion: 'v1',
    });
    expect(saved.status).toBe(201);
    expect((await saved.json()).body).toBe('保存できる架空日記');
    const stopped = await apiRequest(
      liveDemoApp,
      liveDemo,
      token,
      `/entries/${crypto.randomUUID()}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'unused' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(stopped.status).toBe(503);
    expect((await stopped.json()).error).toMatchObject({
      code: 'GENERATION_DISABLED',
      message: '現在、新しい漫画の生成を利用できません。',
      retryable: false,
    });
  });

  it('disables local-connected ingress without a Queue binding', async () => {
    const environment = connectedEnvironment();
    delete environment.GENERATION_QUEUE;
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    boundary.rpcOverrides.set('find_generation_receipt', { status: 200, body: null });
    const turnstileFetch = vi.fn<typeof fetch>();
    const app = appWith(boundary, turnstileFetch);

    const config = await app.request('https://app.example/api/v1/config', {}, environment);
    expect((await config.json()).generationAvailable).toBe(false);
    const response = await apiRequest(
      app,
      environment,
      token,
      `/entries/${crypto.randomUUID()}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: 'fresh-generation-token' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('GENERATION_DISABLED');
    expect(boundary.rpcCalls.map((call) => call.name)).toEqual(['find_generation_receipt']);
    expect(turnstileFetch).not.toHaveBeenCalled();
  });

  it('reads only the owner’s unexpired generation and maps its deterministic sample asset', async () => {
    const environment = connectedEnvironment();
    const owner = crypto.randomUUID();
    const token = await accessToken(environment, owner);
    const boundary = createSupabaseBoundary();
    const generationId = crypto.randomUUID();
    const entry = entryRow(owner, crypto.randomUUID(), { latest_generation_id: null });
    const comic = {
      ...pageComic,
      visual: { kind: 'page' as const, assetId: generationId, textMode: 'external' as const },
    };
    boundary.entries.push(entry);
    boundary.generations.push({
      id: generationId,
      entry_id: entry.id,
      owner_id: owner,
      entry_revision: 1,
      status: 'succeeded',
      stage: null,
      comic_json: comic,
      is_mock: true,
    });
    const app = appWith(boundary);

    const generation = await apiRequest(app, environment, token, `/generations/${generationId}`);
    expect(generation.status).toBe(200);
    expect((await generation.json()).comic.visual.assetId).toBe(generationId);
    const asset = await apiRequest(app, environment, token, `/assets/${generationId}/url`);
    expect(asset.status).toBe(200);
    expect(await asset.json()).toMatchObject({ url: '/sample-comic.svg' });

    const foreignToken = await accessToken(environment, crypto.randomUUID());
    const foreign = await apiRequest(
      app,
      environment,
      foreignToken,
      `/generations/${generationId}`,
    );
    expect(foreign.status).toBe(404);
    const assetRead = boundary.readCalls.find((call) => call.url.pathname.endsWith('/generations'));
    expect(assetRead?.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    expect(assetRead?.url.searchParams.get('id')).toBe(`eq.${generationId}`);

    itemAt(boundary.generations, 0).is_mock = false;
    const realAsset = await apiRequest(app, environment, token, `/assets/${generationId}/url`);
    expect(realAsset.status).toBe(404);
    expect((await realAsset.json()).error.code).toBe('NOT_FOUND');
  });
});
