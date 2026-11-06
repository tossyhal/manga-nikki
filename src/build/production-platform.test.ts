import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gateProductionPlatform,
  PRODUCTION_PLATFORM,
  PRODUCTION_PLATFORM_SECRET_IDS,
  runProductionPlatform,
} from './production-platform.ts';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getBucket: vi.fn(),
  createBucket: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
const bucket = {
  id: 'comics',
  name: 'comics',
  public: false,
  file_size_limit: 8388608,
  allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
};
const input = {
  operation: 'check' as const,
  cloudflareToken: 'cf-test',
  supabaseSecretKey: 'server-test',
  supabasePublishableKey: 'public-test',
};
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'tossyhal/manga-nikki',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_ACTOR_ID: '92223710',
  GITHUB_TRIGGERING_ACTOR: 'tossyhal',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_TOKEN: 'github-test',
  PRODUCTION_PLATFORM_OPERATION: 'check',
  BWS_CLOUDFLARE_SECRET_ID: PRODUCTION_PLATFORM_SECRET_IDS.cloudflare,
  BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID: PRODUCTION_PLATFORM_SECRET_IDS.publishable,
  BWS_SUPABASE_SECRET_KEY_SECRET_ID: PRODUCTION_PLATFORM_SECRET_IDS.server,
};
const ok = (result: unknown) => Response.json({ success: true, result });
function fetcher(queues: unknown[] = [{ queue_name: PRODUCTION_PLATFORM.queueName }]) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(queues))
    .mockResolvedValueOnce(ok({ schedules: [{ cron: '0 15 * * *' }] }));
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBucket.mockResolvedValue({ data: bucket, error: null });
  mocks.createBucket.mockResolvedValue({ data: { name: 'comics' }, error: null });
  mocks.createClient.mockReturnValue({
    storage: { getBucket: mocks.getBucket, createBucket: mocks.createBucket },
  });
});
describe('owner/main gate', () => {
  it('最新mainを検証する', async () => {
    await expect(
      gateProductionPlatform(
        env,
        vi.fn().mockResolvedValue(Response.json({ object: { sha: env.GITHUB_SHA } })),
      ),
    ).resolves.toBe('check');
  });
  it.each([
    { GITHUB_ACTOR_ID: '1' },
    { GITHUB_REF: 'refs/heads/develop' },
    { GITHUB_EVENT_NAME: 'push' },
    { PRODUCTION_PLATFORM_OPERATION: 'setup' },
    {
      PRODUCTION_PLATFORM_OPERATION: 'setup',
      PRODUCTION_PLATFORM_CONFIRMATION: PRODUCTION_PLATFORM.queueName,
      GITHUB_RUN_ATTEMPT: '2',
    },
  ])('不許可contextでnetwork呼出しを止める %j', async (override) => {
    const request = vi.fn<typeof fetch>();
    await expect(gateProductionPlatform({ ...env, ...override }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('main HEAD不一致で停止する', async () => {
    await expect(
      gateProductionPlatform(
        env,
        vi.fn().mockResolvedValue(Response.json({ object: { sha: 'b'.repeat(40) } })),
      ),
    ).rejects.toThrow('PLATFORM_MAIN_STALE');
  });
});
describe('固定resource', () => {
  it('checkでGET以外の操作をしない', async () => {
    const request = fetcher();
    await expect(runProductionPlatform(input, request)).resolves.toMatchObject({
      queue: 'present',
      bucket: 'private-present',
      cron: 'daily-only',
      storagePolicies: 'requires-database-verification',
    });
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(mocks.createBucket).not.toHaveBeenCalled();
  });
  it('Queue権限不足でもprivate Storageを確認し、判明したcodeを返す', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(ok({ schedules: [{ cron: '0 15 * * *' }] }));
    await expect(runProductionPlatform(input, request)).resolves.toMatchObject({
      queue: 'permission-required',
      bucket: 'private-present',
    });
    expect(mocks.getBucket).toHaveBeenCalled();
  });
  it('checkで不足Queueを自動作成しない', async () => {
    await expect(runProductionPlatform(input, fetcher([]))).resolves.toMatchObject({
      queue: 'missing',
    });
  });
  it('setupは不足したQueueとprivate bucketだけを作成する', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ queue_name: PRODUCTION_PLATFORM.queueName }))
      .mockResolvedValueOnce(ok({ schedules: [{ cron: '0 15 * * *' }] }));
    mocks.getBucket.mockResolvedValueOnce({
      data: null,
      error: { statusCode: '404', message: 'Bucket not found' },
    });
    await expect(
      runProductionPlatform({ ...input, operation: 'setup' }, request),
    ).resolves.toMatchObject({ queue: 'created', bucket: 'private-created' });
    expect(mocks.createBucket).toHaveBeenCalledWith('comics', {
      public: false,
      fileSizeLimit: 8388608,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    });
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      queue_name: PRODUCTION_PLATFORM.queueName,
    });
  });
  it.each([{ public: true }, { file_size_limit: 10000000 }, { allowed_mime_types: ['image/*'] }])(
    '既存bucketの不安全設定は変更せず拒否する %j',
    async (override) => {
      mocks.getBucket.mockResolvedValue({ data: { ...bucket, ...override }, error: null });
      await expect(
        runProductionPlatform({ ...input, operation: 'setup' }, fetcher()),
      ).rejects.toThrow('STORAGE_CONFIG_INVALID');
      expect(mocks.createBucket).not.toHaveBeenCalled();
    },
  );
  it('応答失敗の秘密値を例外に含めない', async () => {
    await expect(
      runProductionPlatform(input, vi.fn().mockRejectedValue(new Error('private-secret'))),
    ).rejects.toThrow('PLATFORM_REQUEST_FAILED');
  });
  it('過大Cloudflare応答を拒否する', async () => {
    await expect(
      runProductionPlatform(
        input,
        vi.fn().mockResolvedValue(new Response(' '.repeat(128 * 1024 + 1))),
      ),
    ).rejects.toThrow('PLATFORM_RESPONSE_INVALID');
  });
});

function configureProbe(allowUserWrite = false, cleanupFails = false) {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const remove = vi
    .fn()
    .mockResolvedValue({ error: cleanupFails ? { message: 'private-cleanup-error' } : null });
  const deleteUser = vi.fn().mockResolvedValue({ error: null });
  const adminStorage = {
    upload: vi.fn().mockResolvedValue({ error: null }),
    download: vi.fn().mockResolvedValue({
      data: new Blob([
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YoAAAAASUVORK5CYII=',
          'base64',
        ),
      ]),
      error: null,
    }),
    remove,
    list: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  let createdCount = 0;
  const createUser = vi.fn().mockImplementation(async ({ email }: { email: string }) => ({
    data: { user: { id: ids[createdCount++], email } },
    error: null,
  }));
  const admin = {
    storage: {
      getBucket: mocks.getBucket,
      createBucket: mocks.createBucket,
      from: vi.fn().mockReturnValue(adminStorage),
    },
    auth: {
      admin: {
        createUser,
        generateLink: vi.fn().mockResolvedValue({
          data: { properties: { hashed_token: 'hashed-fixture' } },
          error: null,
        }),
        deleteUser,
      },
    },
  };
  const denied = { data: null, error: { statusCode: '403' } };
  const clients = [0, 1, 2].map((index) => ({
    auth: {
      verifyOtp: vi.fn().mockResolvedValue({
        data: { user: { id: ids[index - 1] }, session: { access_token: 'fixture-jwt' } },
        error: null,
      }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        list: vi.fn().mockResolvedValue({ data: [], error: null }),
        download: vi.fn().mockResolvedValue(denied),
        createSignedUrl: vi.fn().mockResolvedValue(denied),
        upload: vi
          .fn()
          .mockResolvedValue(
            allowUserWrite ? { data: { path: 'unexpected' }, error: null } : denied,
          ),
      }),
    },
  }));
  mocks.createClient.mockReturnValueOnce(admin);
  for (const client of clients) mocks.createClient.mockReturnValueOnce(client);
  return { remove, deleteUser, createUser, clients };
}
describe('一時fixture Storage拒否試験', () => {
  it('adminの往復と匿名/A/Bの拒否を確認し、作成UUIDのユーザーだけを削除する', async () => {
    const state = configureProbe();
    const request = fetcher();
    request.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      runProductionPlatform({ ...input, operation: 'probe-storage' }, request),
    ).resolves.toMatchObject({ storageProbe: 'passed' });
    expect(state.createUser).toHaveBeenCalledTimes(2);
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.deleteUser.mock.calls.map(([id]) => id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    for (const client of state.clients) expect(client.storage.from).toHaveBeenCalledWith('comics');
  });
  it('ユーザーの直接uploadが通った場合もfixtureをcleanupし失敗する', async () => {
    const state = configureProbe(true);
    const request = fetcher();
    request.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      runProductionPlatform({ ...input, operation: 'probe-storage' }, request),
    ).rejects.toThrow('STORAGE_PROBE_FAILED');
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.deleteUser).toHaveBeenCalledTimes(2);
  });
  it('cleanup失敗は成功扱いにせずAuthユーザーcleanupも実行する', async () => {
    const state = configureProbe(false, true);
    const request = fetcher();
    request.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      runProductionPlatform({ ...input, operation: 'probe-storage' }, request),
    ).rejects.toThrow('STORAGE_CLEANUP_FAILED');
    expect(state.deleteUser).toHaveBeenCalledTimes(2);
  });
});
