import { describe, expect, it } from 'vitest';
import { generationFixtures } from '../../../shared/fixtures';
import type { EntryDetail } from '../../../shared/schemas';
import { mergeEntryGenerationProgress, preserveGenerationProgress } from './generationProgress';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('generation progress reconciliation', () => {
  it('does not replace a terminal status with an older in-flight response', () => {
    const succeeded = generationFixtures(entryId, generationId).succeeded;
    const staleRunning = generationFixtures(entryId, generationId).running;

    expect(preserveGenerationProgress(succeeded, staleRunning)).toBe(succeeded);
  });

  it('keeps the known generation when an entry refresh omits its status', () => {
    const succeeded = generationFixtures(entryId, generationId).succeeded;
    const current: EntryDetail = {
      id: entryId,
      diaryDate: '2026-01-01',
      body: '架空の日記',
      revision: 1,
      latestGenerationId: generationId,
      latestGeneration: succeeded,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const incoming: EntryDetail = {
      ...current,
      latestGeneration: null,
    };

    expect(mergeEntryGenerationProgress(current, incoming).latestGeneration).toBe(succeeded);
  });
});
