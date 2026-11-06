import { z } from 'zod';
import { resolveMode, type Environment, type Mode } from './mode';
import { createServerRpcClient } from './supabase-clients';
import { createServerStorageRemovalClient } from './supabase-storage';
import {
  removeAndConfirmStorageObjectAbsent,
  type StorageObjectCleanupClient,
} from './storage-object-cleanup';

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const objectPathPattern = new RegExp(
  `^${uuidPattern}/${uuidPattern}/${uuidPattern}\\.(png|jpg|webp)$`,
);
const deletionTaskSchema = z.strictObject({
  object_path: z.string().max(160),
  claim_token: z.uuid(),
  lease_expires_at: z.iso.datetime({ offset: true }),
});

type DeletionTask = z.infer<typeof deletionTaskSchema>;
type RpcResult = { data: unknown; error: unknown };

export type StorageDeletionCleanupSummary = {
  claimed: number;
  rechecked: number;
  retrying: number;
  stale: number;
};

export class StorageDeletionCleanupError extends Error {
  constructor() {
    super('STORAGE_DELETION_CLEANUP_UNAVAILABLE');
  }
}

export type StorageDeletionCleanupRpc = {
  claim(limit: number): Promise<RpcResult>;
  finalize(objectPath: string, claimToken: string): Promise<RpcResult>;
};

export type StorageDeletionCleanupStorage = StorageObjectCleanupClient;

function tasksFromRpc(data: unknown): DeletionTask[] {
  const parsed = z.array(deletionTaskSchema).safeParse(data);
  if (!parsed.success) throw new StorageDeletionCleanupError();

  const paths = new Set<string>();
  for (const task of parsed.data) {
    if (!objectPathPattern.test(task.object_path) || paths.has(task.object_path))
      throw new StorageDeletionCleanupError();
    paths.add(task.object_path);
  }
  return parsed.data;
}

export function createStorageDeletionCleanupService(
  rpc: StorageDeletionCleanupRpc,
  storage: StorageDeletionCleanupStorage,
  limit = 40,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new StorageDeletionCleanupError();

  return {
    async cleanDuePaths(): Promise<StorageDeletionCleanupSummary> {
      let claimed: RpcResult;
      try {
        claimed = await rpc.claim(limit);
      } catch {
        throw new StorageDeletionCleanupError();
      }
      if (claimed.error !== null) throw new StorageDeletionCleanupError();
      const tasks = tasksFromRpc(claimed.data);
      const summary: StorageDeletionCleanupSummary = {
        claimed: tasks.length,
        rechecked: 0,
        retrying: 0,
        stale: 0,
      };

      for (const task of tasks) {
        if (!(await removeAndConfirmStorageObjectAbsent(storage, task.object_path))) {
          summary.retrying += 1;
          continue;
        }

        try {
          const finalized = await rpc.finalize(task.object_path, task.claim_token);
          if (finalized.error !== null || typeof finalized.data !== 'boolean') {
            summary.retrying += 1;
          } else if (finalized.data) {
            summary.rechecked += 1;
          } else {
            summary.stale += 1;
          }
        } catch {
          summary.retrying += 1;
        }
      }

      return summary;
    },
  };
}

export function createStorageDeletionCleanupServiceForEnvironment(
  environment: Environment,
  fetcher?: typeof fetch,
  limit = 40,
) {
  const serverRpc = createServerRpcClient(environment, fetcher);
  const rpc: StorageDeletionCleanupRpc = {
    claim: async (batchLimit) =>
      await serverRpc.rpc('claim_storage_deletion_cleanup', { p_limit: batchLimit }),
    finalize: async (objectPath, claimToken) =>
      await serverRpc.rpc('finalize_storage_deletion_cleanup', {
        p_object_path: objectPath,
        p_claim_token: claimToken,
        p_storage_absent: true,
      }),
  };
  const storage = createServerStorageRemovalClient(environment, fetcher);
  return createStorageDeletionCleanupService(rpc, storage, limit);
}

export async function cleanStorageDeletionOutboxForScheduledEnvironment(
  environment: Environment,
  fetcher?: typeof fetch,
): Promise<StorageDeletionCleanupSummary | undefined> {
  let mode: Mode;
  try {
    mode = resolveMode(environment, false);
  } catch {
    return undefined;
  }
  if (mode !== 'local-connected' && mode !== 'live-demo') return undefined;

  const summary = await createStorageDeletionCleanupServiceForEnvironment(
    environment,
    fetcher,
  ).cleanDuePaths();
  console.info('storage_deletion_cleanup_summary', summary);
  return summary;
}
