import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../../shared/schemas';
import { getEntries } from '../../lib/api';
import { fetchMonthCoverage } from './libraryCoverage';

vi.mock('../../lib/api', () => ({ getEntries: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function entry(diaryDate: string): Entry {
  return { id: diaryDate, diaryDate } as Entry;
}

describe('fetchMonthCoverage', () => {
  it('publishes the first page before waiting for older pages', async () => {
    const first = entry('2026-11-05');
    const older = entry('2026-10-31');
    let markSecondRequestStarted!: () => void;
    let resolveSecondPage!: (page: { items: Entry[]; nextCursor: string | null }) => void;
    const secondRequestStarted = new Promise<void>((resolve) => {
      markSecondRequestStarted = resolve;
    });

    vi.mocked(getEntries)
      .mockResolvedValueOnce({ items: [first], nextCursor: 'older-page' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondPage = resolve;
            markSecondRequestStarted();
          }),
      );

    const onProgress = vi.fn();
    const result = fetchMonthCoverage(null, null, '2026-11', () => true, undefined, onProgress);

    await secondRequestStarted;
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenLastCalledWith([first], 'older-page');

    resolveSecondPage({ items: [older], nextCursor: null });
    await expect(result).resolves.toEqual({ entries: [first, older], cursor: null });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith([first, older], null);
  });
});
