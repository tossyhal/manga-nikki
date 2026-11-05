import { describe, expect, it, vi } from 'vitest';
import { mockEnvironment, type Environment } from './mode';
import {
  cleanRetainedEntriesForScheduledEnvironment,
  createRetentionCleanupService,
  RetentionCleanupError,
  type RetentionCleanupRpc,
  type RetentionStorage,
} from './retention-cleanup';
import { createServerStorageRemovalClient } from './supabase-storage';

const ownerId = '11111111-1111-4111-8111-111111111111';
const generationId = '22222222-2222-4222-8222-222222222222';
const entryId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';

function assetPath(id: string, owner = ownerId): string {
  return `${owner}/${generationId}/${id}.png`;
}

function cleanupTask(paths: string[], owner = ownerId) {
  return {
    entry_id: entryId,
    owner_id: owner,
    claim_token: claimToken,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    object_paths: paths,
  };
}

function rpcFor(
  tasks: unknown[],
  finalized = true,
): RetentionCleanupRpc & {
  finalized: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(async () => ({ data: tasks, error: null })),
    finalize: vi.fn(async () => ({ data: finalized, error: null })),
    finalized: vi.fn(),
  };
}

function storageFor(existing: Set<string>): RetentionStorage & {
  remove: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  return {
    remove: vi.fn(async (paths: string[]) => {
      for (const path of paths) existing.delete(path);
      return { data: paths.map((path) => ({ name: path.split('/').at(-1) })), error: null };
    }),
    list: vi.fn(async (path: string, options: { search: string }) => ({
      data: [...existing]
        .filter(
          (objectPath) =>
            objectPath.startsWith(`${path}/`) && objectPath.endsWith(`/${options.search}`),
        )
        .map((objectPath) => ({ name: objectPath.split('/').at(-1) })),
      error: null,
    })),
  };
}

describe('scheduled retention cleanup mode gate', () => {
  it('does not access personal data for sample or malformed modes', async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return Response.json([]);
    };
    const localMock: Environment = {
      ...mockEnvironment,
      APP_ENV: 'development',
      DATA_MODE: 'mock',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    };
    const sample: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      DATA_MODE: 'sample',
    };
    const malformed = { ...mockEnvironment, APP_ENV: 'invalid' } as unknown as Environment;

    await expect(
      cleanRetainedEntriesForScheduledEnvironment(localMock, fetcher),
    ).resolves.toBeUndefined();
    await expect(
      cleanRetainedEntriesForScheduledEnvironment(sample, fetcher),
    ).resolves.toBeUndefined();
    await expect(
      cleanRetainedEntriesForScheduledEnvironment(malformed, fetcher),
    ).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });

  it('allows cleanup in a stopped live-demo mode', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json([]);
    };
    const liveDemo: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      SUPABASE_URL: 'https://retention-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
    };

    const summaryLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(cleanRetainedEntriesForScheduledEnvironment(liveDemo, fetcher)).resolves.toEqual(
        {
          claimed: 0,
          deleted: 0,
          retrying: 0,
          stale: 0,
        },
      );
      expect(summaryLog).toHaveBeenCalledWith('retention_cleanup_summary', {
        claimed: 0,
        deleted: 0,
        retrying: 0,
        stale: 0,
      });
      expect(summaryLog).toHaveBeenCalledWith('storage_deletion_cleanup_summary', {
        claimed: 0,
        rechecked: 0,
        retrying: 0,
        stale: 0,
      });
    } finally {
      summaryLog.mockRestore();
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/rest/v1/rpc/claim_retention_cleanup',
      '/rest/v1/rpc/claim_storage_deletion_cleanup',
    ]);
  });

  it('keeps retention results when the independent deletion outbox claim fails', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return requests.length === 1
        ? Response.json([])
        : Response.json({ message: 'private dependency detail' }, { status: 503 });
    };
    const liveDemo: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      SUPABASE_URL: 'https://retention-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(cleanRetainedEntriesForScheduledEnvironment(liveDemo, fetcher)).resolves.toEqual(
        { claimed: 0, deleted: 0, retrying: 0, stale: 0 },
      );
      expect(errorLog).toHaveBeenCalledExactlyOnceWith('storage_deletion_cleanup_unavailable');
    } finally {
      errorLog.mockRestore();
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/rest/v1/rpc/claim_retention_cleanup',
      '/rest/v1/rpc/claim_storage_deletion_cleanup',
    ]);
  });

  it('does not reach storage or finalization when the claim dependency fails', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ message: 'private dependency detail' }, { status: 503 });
    };
    const liveDemo: Environment = {
      ...mockEnvironment,
      APP_ENV: 'production',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      GENERATION_ENABLED: 'false',
      SUPABASE_URL: 'https://retention-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
    };

    await expect(cleanRetainedEntriesForScheduledEnvironment(liveDemo, fetcher)).rejects.toThrow(
      'RETENTION_CLEANUP_UNAVAILABLE',
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/rest/v1/rpc/claim_retention_cleanup',
    ]);
  });
});

describe('retention cleanup service', () => {
  it('removes verified owner paths before calling the finalize RPC', async () => {
    const path = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const rpc = rpcFor([cleanupTask([path])]);
    const storage = storageFor(new Set([path]));
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      retrying: 0,
      stale: 0,
    });

    expect(storage.remove).toHaveBeenCalledWith([path]);
    expect(storage.list).toHaveBeenCalledWith(`${ownerId}/${generationId}`, {
      search: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
      limit: 2,
      offset: 0,
    });
    expect(rpc.finalize).toHaveBeenCalledWith(entryId, claimToken);
  });

  it('keeps metadata on partial Storage failure and retries already removed objects safely', async () => {
    const first = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const second = assetPath('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const existing = new Set([first, second]);
    const rpc = rpcFor([cleanupTask([first, second])]);
    const storage = storageFor(existing);
    storage.remove.mockImplementationOnce(async ([path]) => {
      existing.delete(path!);
      return { data: [{ name: path!.split('/').at(-1) }], error: null };
    });
    storage.remove.mockImplementationOnce(async () => ({ data: null, error: { status: 500 } }));
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      retrying: 1,
      stale: 0,
    });
    expect(rpc.finalize).not.toHaveBeenCalled();
    expect(existing).toEqual(new Set([second]));

    rpc.claim = vi.fn(async () => ({ data: [cleanupTask([first, second])], error: null }));
    await expect(service.cleanDueEntries()).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      retrying: 0,
      stale: 0,
    });
    expect(storage.list).toHaveBeenCalledTimes(3);
    expect(rpc.finalize).toHaveBeenCalledTimes(1);
  });

  it('refuses a path belonging to another owner before making Storage calls', async () => {
    const path = assetPath(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '99999999-9999-4999-8999-999999999999',
    );
    const rpc = rpcFor([cleanupTask([path])]);
    const storage = storageFor(new Set([path]));
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).rejects.toBeInstanceOf(RetentionCleanupError);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(rpc.finalize).not.toHaveBeenCalled();
  });

  it('does not finalize when the storage listing still finds the object', async () => {
    const path = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const rpc = rpcFor([cleanupTask([path])]);
    const storage = storageFor(new Set([path]));
    storage.remove.mockImplementation(async () => ({ data: [], error: null }));
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).resolves.toMatchObject({ retrying: 1, deleted: 0 });
    expect(rpc.finalize).not.toHaveBeenCalled();
  });

  it('treats an already absent object as removed only after listing confirms absence', async () => {
    const path = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const rpc = rpcFor([cleanupTask([path])]);
    const storage = storageFor(new Set());
    storage.remove.mockResolvedValue({ data: [], error: null });
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).resolves.toMatchObject({ deleted: 1, retrying: 0 });
    expect(storage.list).toHaveBeenCalledTimes(1);
    expect(rpc.finalize).toHaveBeenCalledTimes(1);
  });

  it('reports a stale lease without deleting database metadata', async () => {
    const rpc = rpcFor([cleanupTask([])], false);
    const service = createRetentionCleanupService(rpc, storageFor(new Set()));

    await expect(service.cleanDueEntries()).resolves.toMatchObject({ stale: 1, deleted: 0 });
  });

  it('replaces dependency details with a general error', async () => {
    const rpc = rpcFor([]);
    rpc.claim = vi.fn(async () => ({ data: null, error: { message: 'private value' } }));
    const service = createRetentionCleanupService(rpc, storageFor(new Set()));

    await expect(service.cleanDueEntries()).rejects.toThrow('RETENTION_CLEANUP_UNAVAILABLE');
    await expect(service.cleanDueEntries()).rejects.not.toThrow('private value');
    expect(rpc.finalize).not.toHaveBeenCalled();
  });
});

describe('server Storage client', () => {
  function environment(): Environment {
    return {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      SUPABASE_URL: 'https://retention-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
    };
  }

  it('uses the private comics endpoint and only the server secret key', async () => {
    const requests: Request[] = [];
    const responses = [Response.json([]), Response.json([])];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift() ?? Response.json([]);
    };
    const storage = createServerStorageRemovalClient(environment(), fetcher);
    const path = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    await expect(storage.remove([path])).resolves.toMatchObject({ data: [], error: null });
    await expect(
      storage.list(`${ownerId}/${generationId}`, {
        search: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
        limit: 2,
        offset: 0,
      }),
    ).resolves.toMatchObject({ data: [], error: null });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe('https://retention-test.supabase.co/storage/v1/object/comics');
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer sb_secret_test_only');
    expect(requests[0]?.headers.get('apikey')).toBe('sb_secret_test_only');
    expect(await requests[0]?.clone().json()).toEqual({ prefixes: [path] });
    expect(requests[1]?.url).toContain('/storage/v1/object/list/comics');
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer sb_secret_test_only');
  });

  it('returns Storage failures to the cleanup service without exposing them as messages', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ statusCode: '500', error: 'Storage unavailable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    const storage = createServerStorageRemovalClient(environment(), fetcher);

    const result = await storage.remove([assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]);
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(JSON.stringify(result.error)).not.toContain('sb_secret_test_only');
  });

  it('retries a partially removed path set and verifies each path through the SDK list API', async () => {
    const first = assetPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const second = assetPath('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const responses = [
      Response.json([]),
      Response.json([]),
      Response.json(
        { statusCode: '500', error: 'failure', message: 'storage unavailable' },
        {
          status: 500,
        },
      ),
      Response.json([]),
      Response.json([]),
      Response.json([]),
      Response.json([]),
    ];
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    };
    const rpc = rpcFor([cleanupTask([first, second])]);
    rpc.claim = vi.fn(async () => ({ data: [cleanupTask([first, second])], error: null }));
    const storage = createServerStorageRemovalClient(environment(), fetcher);
    const service = createRetentionCleanupService(rpc, storage);

    await expect(service.cleanDueEntries()).resolves.toMatchObject({ retrying: 1, deleted: 0 });
    expect(rpc.finalize).not.toHaveBeenCalled();
    rpc.claim = vi.fn(async () => ({ data: [cleanupTask([first, second])], error: null }));

    await expect(service.cleanDueEntries()).resolves.toMatchObject({ retrying: 0, deleted: 1 });
    expect(rpc.finalize).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/storage/v1/object/comics',
      '/storage/v1/object/list/comics',
      '/storage/v1/object/comics',
      '/storage/v1/object/comics',
      '/storage/v1/object/list/comics',
      '/storage/v1/object/comics',
      '/storage/v1/object/list/comics',
    ]);
    expect(
      requests.every(
        (request) => request.headers.get('Authorization') === 'Bearer sb_secret_test_only',
      ),
    ).toBe(true);
  });
});
