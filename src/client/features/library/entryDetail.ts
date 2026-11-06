import type { EntryDetail, Generation } from '../../../shared/schemas';

export function isCurrentEntryGeneration(
  entry: EntryDetail,
  generation: Generation | null | undefined,
): generation is Generation {
  return Boolean(
    generation &&
    generation.id === entry.latestGenerationId &&
    generation.entryId === entry.id &&
    generation.entryRevision <= entry.revision,
  );
}

export async function completeEntryDetail(
  entry: EntryDetail,
  loadGeneration: (id: string) => Promise<Generation>,
): Promise<EntryDetail> {
  let latestGeneration = isCurrentEntryGeneration(entry, entry.latestGeneration)
    ? entry.latestGeneration
    : null;
  if (!latestGeneration && entry.latestGenerationId)
    latestGeneration = await loadGeneration(entry.latestGenerationId).catch(() => null);

  const validLatestGeneration = isCurrentEntryGeneration(entry, latestGeneration)
    ? latestGeneration
    : null;
  const lastSuccessfulGeneration =
    validLatestGeneration?.status === 'succeeded'
      ? validLatestGeneration
      : entry.lastSuccessfulGeneration?.status === 'succeeded' &&
          entry.lastSuccessfulGeneration.entryId === entry.id &&
          entry.lastSuccessfulGeneration.entryRevision <= entry.revision
        ? entry.lastSuccessfulGeneration
        : null;

  return {
    ...entry,
    latestGeneration: validLatestGeneration,
    lastSuccessfulGeneration,
  };
}
