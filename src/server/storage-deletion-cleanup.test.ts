import { describe, expect, it, vi } from 'vitest';
import { mockEnvironment, type Environment } from './mode';
import {
  cleanStorageDeletionOutboxForScheduledEnvironment,
  createStorageDeletionCleanupService,
  StorageDeletionCleanupError,
  type StorageDeletionCleanupRpc,
  type StorageDeletionCleanupStorage,
} from './storage-deletion-cleanup';

const ownerId = '11111111-1111-4111-8111-111111111111';
const generationId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const path = `${ownerId}/${generationId}/${assetId}.png`;

function deletionTask(objectPath = path) {
  return {
    object_path: objectPath,
    claim_token: claimToken,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function rpcFor(tasks: unknown[], finalized = true) {
  const rpc: StorageDeletionCleanupRpc & {
    claim: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
  } = {
    claim: vi.fn(async () => ({ data: tasks, error: null })),
    finalize: vi.fn(async () => ({ data: finalized, error: null })),
  };
  return rpc;
}

function storageFor(existing: Set<string>) {
  const storage: StorageDeletionCleanupStorage & {
    remove: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  } = {
    remove: vi.fn(async (paths: string[]) => {
      for (const objectPath of paths) existing.delete(objectPath);
      return {
        data: paths.map((objectPath) => ({ name: objectPath.split('/').at(-1) })),
        error: null,
      };
    }),
    list: vi.fn(async (folder: string, options: { search: string }) => ({
      data: [...existing]
        .filter(
          (objectPath) =>
            objectPath.startsWith(`${folder}/`) && objectPath.endsWith(`/${options.search}`),
        )
        .map((objectPath) => ({ name: objectPath.split('/').at(-1) })),
      error: null,
    })),
  };
  return storage;
}

describe('storage deletion outbox cleanup mode gate', () => {
  it('does not contact Supabase for sample, mock, or malformed modes', async () => {
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
      cleanStorageDeletionOutboxForScheduledEnvironment(localMock, fetcher),
    ).resolves.toBeUndefined();
    await expect(
      cleanStorageDeletionOutboxForScheduledEnvironment(sample, fetcher),
    ).resolves.toBeUndefined();
    await expect(
      cleanStorageDeletionOutboxForScheduledEnvironment(malformed, fetcher),
    ).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });

  it('claims only the private cleanup RPC in a stopped live-demo environment', async () => {
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
      SUPABASE_URL: 'https://storage-gc-test.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
    };

    await expect(
      cleanStorageDeletionOutboxForScheduledEnvironment(liveDemo, fetcher),
    ).resolves.toEqual({ claimed: 0, rechecked: 0, retrying: 0, stale: 0 });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/rest/v1/rpc/claim_storage_deletion_cleanup',
    ]);
  });
});

describe('storage deletion outbox cleanup service', () => {
  it('removes and verifies each path before scheduling its next daily check', async () => {
    const rpc = rpcFor([deletionTask()]);
    const storage = storageFor(new Set([path]));
    const service = createStorageDeletionCleanupService(rpc, storage);

    await expect(service.cleanDuePaths()).resolves.toEqual({
      claimed: 1,
      rechecked: 1,
      retrying: 0,
      stale: 0,
    });
    expect(storage.remove).toHaveBeenCalledWith([path]);
    expect(storage.list).toHaveBeenCalledWith(`${ownerId}/${generationId}`, {
      search: `${assetId}.png`,
      limit: 2,
      offset: 0,
    });
    expect(rpc.finalize).toHaveBeenCalledWith(path, claimToken);
  });

  it('removes an object recreated after an earlier successful check', async () => {
    const existing = new Set([path]);
    const rpc = rpcFor([deletionTask()]);
    const storage = storageFor(existing);
    const service = createStorageDeletionCleanupService(rpc, storage);

    await expect(service.cleanDuePaths()).resolves.toMatchObject({ rechecked: 1 });
    existing.add(path);
    await expect(service.cleanDuePaths()).resolves.toMatchObject({ rechecked: 1 });

    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(rpc.finalize).toHaveBeenCalledTimes(2);
    expect(existing.has(path)).toBe(false);
  });

  it('keeps other paths moving when Storage fails for one path', async () => {
    const secondPath = `${ownerId}/${generationId}/55555555-5555-4555-8555-555555555555.webp`;
    const rpc = rpcFor([deletionTask(), deletionTask(secondPath)]);
    const storage = storageFor(new Set([path, secondPath]));
    storage.remove.mockImplementationOnce(async () => ({ data: null, error: { status: 500 } }));
    const service = createStorageDeletionCleanupService(rpc, storage);

    await expect(service.cleanDuePaths()).resolves.toEqual({
      claimed: 2,
      rechecked: 1,
      retrying: 1,
      stale: 0,
    });
    expect(rpc.finalize).toHaveBeenCalledTimes(1);
    expect(rpc.finalize).toHaveBeenCalledWith(secondPath, claimToken);
  });

  it('does not finalize while list still finds an object and reports stale leases', async () => {
    const rpc = rpcFor([deletionTask()], false);
    const storage = storageFor(new Set([path]));
    storage.remove.mockImplementation(async () => ({ data: [], error: null }));
    const service = createStorageDeletionCleanupService(rpc, storage);

    await expect(service.cleanDuePaths()).resolves.toEqual({
      claimed: 1,
      rechecked: 0,
      retrying: 1,
      stale: 0,
    });
    expect(rpc.finalize).not.toHaveBeenCalled();

    storage.remove.mockImplementation(async (paths: string[]) => ({ data: paths, error: null }));
    storage.list.mockImplementation(async () => ({ data: [], error: null }));
    await expect(service.cleanDuePaths()).resolves.toEqual({
      claimed: 1,
      rechecked: 0,
      retrying: 0,
      stale: 1,
    });
  });

  it('rejects malformed and duplicate paths before Storage access', async () => {
    const badPathRpc = rpcFor([deletionTask('other-owner/not-a-generation/image.png')]);
    const badPathStorage = storageFor(new Set());
    await expect(
      createStorageDeletionCleanupService(badPathRpc, badPathStorage).cleanDuePaths(),
    ).rejects.toBeInstanceOf(StorageDeletionCleanupError);
    expect(badPathStorage.remove).not.toHaveBeenCalled();

    const duplicateRpc = rpcFor([deletionTask(), deletionTask()]);
    const duplicateStorage = storageFor(new Set());
    await expect(
      createStorageDeletionCleanupService(duplicateRpc, duplicateStorage).cleanDuePaths(),
    ).rejects.toBeInstanceOf(StorageDeletionCleanupError);
    expect(duplicateStorage.remove).not.toHaveBeenCalled();
  });
});
