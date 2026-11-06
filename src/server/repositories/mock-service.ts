import type { z } from 'zod';
import { createEntrySchema, generateSchema, jstToday, type Entry } from '../../shared/schemas';
import { pageComic } from '../../shared/fixtures';
import { ApiError } from '../http';
import type { MockRepository } from './mock';

export function getMockQuota(repository: MockRepository, owner: string) {
  const day = jstToday();
  const resetAt = new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString();
  return {
    remainingToday: Math.max(0, 2 - (repository.counts.get(`${owner}:${day}`) ?? 0)),
    activeGenerationId: null,
    resetAt,
    generationAvailable: true,
  };
}

export function createMockEntry(
  repository: MockRepository,
  owner: string,
  input: z.infer<typeof createEntrySchema>,
) {
  const requestKey = `${owner}:${input.createRequestId}`;
  if (repository.entryTombstones.has(requestKey)) throw new ApiError(404, 'NOT_FOUND');
  const existing = [...repository.entries.values()].find(
    (x) => x.owner === owner && x.requestId === input.createRequestId,
  );
  if (existing) {
    if (
      existing.createFingerprint !==
      JSON.stringify([input.diaryDate, input.body, input.consentVersion])
    )
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
    return existing.entry;
  }
  if (
    [...repository.entries.values()].filter((x) => x.owner === owner && !x.entry.latestGenerationId)
      .length >= 20
  )
    throw new ApiError(429, 'DRAFT_LIMIT_REACHED');
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    diaryDate: input.diaryDate,
    body: input.body,
    revision: 1,
    latestGenerationId: null,
    createdAt: now,
    updatedAt: now,
  };
  repository.entries.set(entry.id, {
    owner,
    requestId: input.createRequestId,
    createFingerprint: JSON.stringify([input.diaryDate, input.body, input.consentVersion]),
    entry,
  });
  return entry;
}

export function listMockEntries(
  repository: MockRepository,
  owner: string,
  limit: number,
  cursor: string | undefined,
) {
  const sorted = [...repository.entries.values()]
    .filter((x) => x.owner === owner)
    .map((x) => x.entry)
    .sort((a, b) => b.diaryDate.localeCompare(a.diaryDate) || b.id.localeCompare(a.id));
  const index = cursor ? sorted.findIndex((x) => x.id === cursor) : -1;
  if (cursor && index < 0) throw new ApiError(400, 'INVALID_INPUT');
  const items = sorted.slice(index + 1, index + 1 + limit);
  return {
    items,
    nextCursor: sorted.length > index + 1 + limit ? (items.at(-1)?.id ?? null) : null,
  };
}

export function getMockEntry(repository: MockRepository, id: string, owner: string) {
  const found = repository.entries.get(id);
  if (!found || found.owner !== owner) throw new ApiError(404, 'NOT_FOUND');
  return found;
}

export function getMockEntryDetail(repository: MockRepository, id: string, owner: string) {
  const found = getMockEntry(repository, id, owner);
  const latestStored = found.entry.latestGenerationId
    ? repository.generations.get(found.entry.latestGenerationId)
    : null;
  const latestGeneration =
    latestStored?.owner === owner && latestStored.generation.entryId === found.entry.id
      ? latestStored.generation
      : null;
  const queriedLastSuccessfulGeneration = [...repository.generations.values()]
    .reverse()
    .find(
      (stored) =>
        stored.owner === owner &&
        stored.generation.entryId === found.entry.id &&
        stored.generation.entryRevision <= found.entry.revision &&
        stored.generation.status === 'succeeded',
    )?.generation;
  const lastSuccessfulGeneration =
    latestGeneration?.status === 'succeeded' ? latestGeneration : queriedLastSuccessfulGeneration;

  return {
    ...found.entry,
    latestGeneration,
    lastSuccessfulGeneration: lastSuccessfulGeneration ?? null,
  };
}

export function reserveMockGeneration(
  repository: MockRepository,
  owner: string,
  entry: Entry,
  key: string,
  input: z.infer<typeof generateSchema>,
) {
  const old = [...repository.generations.values()].find((x) => x.owner === owner && x.key === key);
  if (
    old &&
    (old.generation.entryId !== entry.id || old.generation.entryRevision !== input.expectedRevision)
  )
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
  if (!old && input.expectedRevision !== entry.revision)
    throw new ApiError(409, 'REVISION_CONFLICT');
  const receipt = (id: string) => ({
    generationId: id,
    status: 'queued' as const,
    statusUrl: `/api/v1/generations/${id}`,
  });
  if (old) return receipt(old.generation.id);
  if (
    [...repository.generations.values()].some(
      (stored) =>
        stored.owner === owner &&
        stored.generation.entryId === entry.id &&
        stored.generation.entryRevision === input.expectedRevision &&
        stored.generation.status === 'succeeded',
    )
  )
    throw new ApiError(409, 'REVISION_ALREADY_GENERATED');
  const counter = `${owner}:${jstToday()}`;
  const count = repository.counts.get(counter) ?? 0;
  if (count >= 2) throw new ApiError(429, 'USER_LIMIT_REACHED');
  const id = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const entryRevision = entry.revision;
  const comic = {
    ...pageComic,
    visual: { kind: 'page' as const, assetId, textMode: 'external' as const },
  };
  repository.generations.set(id, {
    owner,
    key,
    generation: {
      id,
      entryId: entry.id,
      entryRevision,
      status: 'succeeded',
      stage: null,
      comic,
      mock: true,
    },
  });
  repository.counts.set(counter, count + 1);
  entry.latestGenerationId = id;
  return receipt(id);
}
