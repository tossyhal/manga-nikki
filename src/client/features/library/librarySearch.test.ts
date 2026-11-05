import { describe, expect, it } from 'vitest';
import {
  defaultLibrarySearch,
  parseLibrarySearch,
  serializeLibrarySearch,
  validateLibraryBackTo,
} from './librarySearch';

describe('library search state', () => {
  it('serializes and restores the selected view, date, and 1-based pages', () => {
    const state = {
      view: 'list' as const,
      month: '2026-11',
      day: '2026-11-05',
      listPage: 8,
      dayPage: 3,
    };

    const search = serializeLibrarySearch(state);

    expect(search).toBe('?view=list&month=2026-11&day=2026-11-05&listPage=8&dayPage=3');
    expect(parseLibrarySearch(search, '2026-11-05')).toEqual(state);
    expect(defaultLibrarySearch('2026-11-05')).toEqual({
      view: 'calendar',
      month: '2026-11',
      day: '2026-11-05',
      listPage: 1,
      dayPage: 1,
    });
  });

  it('clamps the selected day to the chosen month and keeps page 51 valid', () => {
    expect(parseLibrarySearch('?month=2025-02&listPage=51', '2025-01-31')).toEqual({
      view: 'calendar',
      month: '2025-02',
      day: '2025-02-28',
      listPage: 51,
      dayPage: 1,
    });
  });

  it.each([
    '?month=2026-02-29',
    '?day=2026-04-31',
    '?month=2026-01&day=2026-02-01',
    '?listPage=0',
    '?listPage=-1',
    '?listPage=9007199254740992',
    '?dayPage=0',
    '?view=grid',
    '?unknown=value',
    '?view=list&view=calendar',
    '?dayPage=1&dayPage=2',
  ])('rejects invalid or ambiguous search state %s', (search) => {
    expect(parseLibrarySearch(search, '2026-11-05')).toBeNull();
  });
});

describe('validateLibraryBackTo', () => {
  it.each([
    'https://example.com/library?view=list',
    '//example.com/library?view=list',
    '/library?view=list&unknown=value',
    '/library?view=list&view=calendar',
    '/library?day=2026-02-30',
    '/library?month=2026-01&day=2026-02-01',
    '/library?listPage=9007199254740992',
    '/library#top',
    '/library\\outside',
  ])('rejects unsafe back target %s', (value) => {
    expect(validateLibraryBackTo(value)).toBeNull();
  });

  it('allows the same-origin library route and preserves its valid query', () => {
    const destination = '/library?view=list&month=2026-11&day=2026-11-05&listPage=2&dayPage=3';

    expect(validateLibraryBackTo(destination)).toBe(destination);
    expect(validateLibraryBackTo('/library')).toBe('/library');
  });
});
