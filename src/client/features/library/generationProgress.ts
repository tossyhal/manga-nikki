import type { EntryDetail, Generation } from '../../../shared/schemas';

const generationStatusRank: Record<Generation['status'], number> = {
  queued: 0,
  running: 1,
  unknown: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
};

export function preserveGenerationProgress(current: Generation, incoming: Generation): Generation {
  if (current.id !== incoming.id) return incoming;
  const currentRank = generationStatusRank[current.status];
  const incomingRank = generationStatusRank[incoming.status];
  if (currentRank > incomingRank) return current;
  if (currentRank === 3 && incomingRank === 3 && current.status !== incoming.status) return current;
  return incoming;
}

export function mergeEntryGenerationProgress(
  current: EntryDetail | null,
  incoming: EntryDetail,
): EntryDetail {
  if (!current || current.id !== incoming.id || !current.latestGeneration) return incoming;
  if (
    current.latestGenerationId !== incoming.latestGenerationId ||
    current.latestGeneration.id !== incoming.latestGenerationId
  )
    return incoming;
  return {
    ...incoming,
    latestGeneration: incoming.latestGeneration
      ? preserveGenerationProgress(current.latestGeneration, incoming.latestGeneration)
      : current.latestGeneration,
  };
}
