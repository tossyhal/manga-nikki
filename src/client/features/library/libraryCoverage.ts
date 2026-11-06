import type { Entry } from '../../../shared/schemas';
import { getEntries } from '../../lib/api';
import { maxListRestoreRequests } from './librarySearch';

export const pageSize = 20;
export const listPageSize = 3;
export const dayPageSize = 2;
type EntryPage = { entries: Entry[]; cursor: string | null };
type ListCoverage = EntryPage & { reachedTarget: boolean };

function mergeEntries(current: Entry[], next: Entry[]) {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...next.filter((entry) => !seen.has(entry.id))];
}

export function hasMonthCoverage(entries: Entry[], cursor: string | null, month: string) {
  if (!cursor) return true;
  const oldest = entries.at(-1);
  return oldest !== undefined && oldest.diaryDate < `${month}-01`;
}

export async function fetchMonthCoverage(
  initialEntries: Entry[] | null,
  initialCursor: string | null,
  targetMonth: string,
  shouldContinue: () => boolean,
  signal?: AbortSignal,
) {
  let entries = initialEntries;
  let cursor = initialCursor;

  if (entries === null) {
    const firstPage = await getEntries({ limit: pageSize, signal });
    if (!shouldContinue()) return null;
    entries = firstPage.items;
    cursor = firstPage.nextCursor;
  }

  const visitedCursors = new Set<string>();
  while (!hasMonthCoverage(entries, cursor, targetMonth) && cursor) {
    if (visitedCursors.has(cursor)) {
      throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
    }
    visitedCursors.add(cursor);
    const previousCursor = cursor;
    const page = await getEntries({ cursor, limit: pageSize, signal });
    if (!shouldContinue()) return null;
    if (page.nextCursor === previousCursor) {
      throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
    }
    entries = mergeEntries(entries, page.items);
    cursor = page.nextCursor;
  }

  return { entries, cursor };
}

export function targetEntryCount(page: number) {
  return page > Math.floor(Number.MAX_SAFE_INTEGER / listPageSize)
    ? Number.MAX_SAFE_INTEGER
    : page * listPageSize;
}

export async function fetchListCoverage(
  initialEntries: Entry[],
  initialCursor: string | null,
  targetPage: number,
  shouldContinue: () => boolean,
  requestLimit = maxListRestoreRequests,
  signal?: AbortSignal,
): Promise<ListCoverage | null> {
  let entries = initialEntries;
  let cursor = initialCursor;
  let requests = 0;
  const visitedCursors = new Set<string>();
  const neededEntries = targetEntryCount(targetPage);

  while (entries.length < neededEntries && cursor && requests < requestLimit) {
    if (visitedCursors.has(cursor)) {
      throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
    }
    visitedCursors.add(cursor);
    const previousCursor = cursor;
    const page = await getEntries({ cursor, limit: pageSize, signal });
    if (!shouldContinue()) return null;
    if (page.nextCursor === previousCursor) {
      throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
    }
    entries = mergeEntries(entries, page.items);
    cursor = page.nextCursor;
    requests += 1;
  }

  return {
    entries,
    cursor,
    reachedTarget: entries.length >= neededEntries || cursor === null,
  };
}
