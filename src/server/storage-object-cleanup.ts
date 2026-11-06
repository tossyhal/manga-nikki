export type StorageObjectCleanupClient = {
  remove(paths: string[]): Promise<{ data: unknown; error: unknown }>;
  list(
    path: string,
    options: { search: string; limit: number; offset: number },
  ): Promise<{ data: unknown; error: unknown }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function removeAndConfirmStorageObjectAbsent(
  storage: StorageObjectCleanupClient,
  objectPath: string,
): Promise<boolean> {
  const [ownerId, generationId, name] = objectPath.split('/');

  try {
    const removed = await storage.remove([objectPath]);
    if (removed.error !== null || !Array.isArray(removed.data)) return false;

    const listed = await storage.list(`${ownerId}/${generationId}`, {
      search: name!,
      limit: 2,
      offset: 0,
    });
    return (
      listed.error === null &&
      Array.isArray(listed.data) &&
      !listed.data.some((item) => !isRecord(item) || item.name === name)
    );
  } catch {
    return false;
  }
}
