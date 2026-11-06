import { describe, expect, it, vi } from 'vitest';
import { generationFixtures } from '../../../shared/fixtures';
import type { EntryDetail, Generation } from '../../../shared/schemas';
import { completeEntryDetail } from './entryDetail';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function detail(latestGeneration: Generation | null = null): EntryDetail {
  return {
    id: entryId,
    diaryDate: '2026-11-06',
    body: '架空の日記',
    revision: 1,
    latestGenerationId: latestGeneration?.id ?? generationId,
    latestGeneration,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
  };
}

describe('completeEntryDetail', () => {
  it('fills a missing latest generation and preserves its successful result', async () => {
    const succeeded = generationFixtures(entryId, generationId, 1).succeeded;
    const loadGeneration = vi.fn(async () => succeeded);

    const result = await completeEntryDetail(detail(), loadGeneration);

    expect(loadGeneration).toHaveBeenCalledWith(generationId);
    expect(result.latestGeneration).toEqual(succeeded);
    expect(result.lastSuccessfulGeneration).toEqual(succeeded);
  });

  it('rejects embedded and fetched generations from another entry revision', async () => {
    const staleEmbedded = generationFixtures(
      entryId,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      1,
    ).succeeded;
    const newerThanEntry = generationFixtures(entryId, generationId, 2).succeeded;
    const loadGeneration = vi.fn(async () => newerThanEntry);

    const result = await completeEntryDetail(
      { ...detail(), latestGeneration: staleEmbedded },
      loadGeneration,
    );

    expect(loadGeneration).toHaveBeenCalledWith(generationId);
    expect(result.latestGeneration).toBeNull();
    expect(result.lastSuccessfulGeneration).toBeNull();
  });
});
