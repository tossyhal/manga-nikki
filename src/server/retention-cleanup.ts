import { z } from 'zod';
import { resolveMode, type Environment, type Mode } from './mode';
import { createServerRpcClient } from './supabase-clients';
import { createServerStorageRemovalClient } from './supabase-storage';
import { cleanStorageDeletionOutboxForScheduledEnvironment } from './storage-deletion-cleanup';
import {
  removeAndConfirmStorageObjectAbsent,
  type StorageObjectCleanupClient,
} from './storage-object-cleanup';

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const objectPathPattern = new RegExp(
  `^${uuidPattern}/${uuidPattern}/${uuidPattern}\\.(png|jpg|webp)$`,
);
const cleanupTaskSchema = z.strictObject({
  entry_id: z.uuid(),
  owner_id: z.uuid(),
  claim_token: z.uuid(),
  lease_expires_at: z.iso.datetime({ offset: true }),
  object_paths: z.array(z.string().max(160)),
});

type CleanupTask = z.infer<typeof cleanupTaskSchema>;
type RpcResult = { data: unknown; error: unknown };

export type RetentionCleanupSummary = {
  claimed: number;
  deleted: number;
  retrying: number;
  stale: number;
};

export class RetentionCleanupError extends Error {
  constructor() {
    super('RETENTION_CLEANUP_UNAVAILABLE');
  }
}

export type RetentionCleanupRpc = {
  claim(limit: number): Promise<RpcResult>;
  finalize(entryId: string, claimToken: string): Promise<RpcResult>;
};

export type RetentionStorage = StorageObjectCleanupClient;

function isSafePath(path: string, ownerId: string): boolean {
  if (!objectPathPattern.test(path)) return false;
  return path.startsWith(`${ownerId.toLowerCase()}/`);
}

function tasksFromRpc(data: unknown): CleanupTask[] {
  const parsed = z.array(cleanupTaskSchema).safeParse(data);
  if (!parsed.success) throw new RetentionCleanupError();

  for (const task of parsed.data) {
    const uniquePaths = new Set(task.object_paths);
    if (
      uniquePaths.size !== task.object_paths.length ||
      task.object_paths.some((path) => !isSafePath(path, task.owner_id))
    )
      throw new RetentionCleanupError();
  }
  return parsed.data;
}

export function createRetentionCleanupService(
  rpc: RetentionCleanupRpc,
  storage: RetentionStorage,
  limit = 10,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RetentionCleanupError();

  return {
    async cleanDueEntries(): Promise<RetentionCleanupSummary> {
      let claimed: RpcResult;
      try {
        claimed = await rpc.claim(limit);
      } catch {
        throw new RetentionCleanupError();
      }
      if (claimed.error !== null) throw new RetentionCleanupError();
      const tasks = tasksFromRpc(claimed.data);
      const summary: RetentionCleanupSummary = {
        claimed: tasks.length,
        deleted: 0,
        retrying: 0,
        stale: 0,
      };

      for (const task of tasks) {
        let storageDeleted = true;
        for (const path of task.object_paths) {
          if (!(await removeAndConfirmStorageObjectAbsent(storage, path))) {
            storageDeleted = false;
            break;
          }
        }

        if (!storageDeleted) {
          summary.retrying += 1;
          continue;
        }

        let finalized: RpcResult;
        try {
          finalized = await rpc.finalize(task.entry_id, task.claim_token);
        } catch {
          throw new RetentionCleanupError();
        }
        if (finalized.error !== null || typeof finalized.data !== 'boolean')
          throw new RetentionCleanupError();
        if (finalized.data) summary.deleted += 1;
        else summary.stale += 1;
      }

      return summary;
    },
  };
}

export function createRetentionCleanupServiceForEnvironment(
  environment: Environment,
  fetcher?: typeof fetch,
  limit = 10,
) {
  const serverRpc = createServerRpcClient(environment, fetcher);
  const rpc: RetentionCleanupRpc = {
    claim: async (batchLimit) =>
      await serverRpc.rpc('claim_retention_cleanup', { p_limit: batchLimit }),
    finalize: async (entryId, claimToken) =>
      await serverRpc.rpc('finalize_retention_cleanup', {
        p_entry_id: entryId,
        p_claim_token: claimToken,
        p_storage_deleted: true,
      }),
  };
  const storage = createServerStorageRemovalClient(environment, fetcher);
  return createRetentionCleanupService(rpc, storage, limit);
}

export async function cleanRetainedEntriesForScheduledEnvironment(
  environment: Environment,
  fetcher?: typeof fetch,
): Promise<RetentionCleanupSummary | undefined> {
  let mode: Mode;
  try {
    mode = resolveMode(environment, false);
  } catch {
    return undefined;
  }
  if (mode !== 'local-connected' && mode !== 'live-demo') return undefined;

  try {
    const summary = await createRetentionCleanupServiceForEnvironment(
      environment,
      fetcher,
    ).cleanDueEntries();
    console.info('retention_cleanup_summary', summary);
    return summary;
  } finally {
    try {
      await cleanStorageDeletionOutboxForScheduledEnvironment(environment, fetcher);
    } catch {
      console.error('storage_deletion_cleanup_unavailable');
    }
  }
}
