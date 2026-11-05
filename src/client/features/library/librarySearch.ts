export type LibraryView = 'calendar' | 'list';

export type LibrarySearchState = {
  view: LibraryView;
  month: string;
  day: string;
  listPage: number;
  dayPage: number;
};

export const maxListRestoreRequests = 50;

const allowedKeys = new Set(['view', 'month', 'day', 'listPage', 'dayPage']);

function isValidMonth(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return Boolean(match && Number(match[1]) > 0);
}

function daysInMonth(month: string): number {
  const [yearText = '0', monthText = '0'] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (!isValidMonth(month)) return 0;
  if (monthNumber === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

function isValidDay(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match || Number(match[1]) === 0) return false;
  return Number(match[3]) <= daysInMonth(`${match[1]}-${match[2]}`);
}

function parsePage(value: string | null, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= max ? page : null;
}

function readAllowedValues(search: string): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!allowedKeys.has(key) || values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

export function parseLibrarySearch(search: string, today: string): LibrarySearchState | null {
  const values = readAllowedValues(search);
  if (!values) return null;

  const viewValue = values.get('view');
  if (viewValue !== undefined && viewValue !== 'calendar' && viewValue !== 'list') return null;

  const monthValue = values.get('month');
  if (monthValue !== undefined && !isValidMonth(monthValue)) return null;

  const dayValue = values.get('day');
  if (dayValue !== undefined && !isValidDay(dayValue)) return null;
  if (monthValue && dayValue && dayValue.slice(0, 7) !== monthValue) return null;

  const listPage = parsePage(values.get('listPage') ?? null);
  const dayPage = parsePage(values.get('dayPage') ?? null);
  if (listPage === null || dayPage === null) return null;

  const month = monthValue ?? dayValue?.slice(0, 7) ?? today.slice(0, 7);
  const day = dayValue ?? moveDateToMonth(today, month);

  return {
    view: viewValue === 'list' ? 'list' : 'calendar',
    month,
    day,
    listPage,
    dayPage,
  };
}

function moveDateToMonth(value: string, targetMonth: string): string {
  const day = Number(value.slice(-2));
  const lastDay = daysInMonth(targetMonth);
  return `${targetMonth}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function defaultLibrarySearch(today: string): LibrarySearchState {
  return {
    view: 'calendar',
    month: today.slice(0, 7),
    day: today,
    listPage: 1,
    dayPage: 1,
  };
}

export function serializeLibrarySearch(state: LibrarySearchState): string {
  const params = new URLSearchParams();
  params.set('view', state.view);
  params.set('month', state.month);
  params.set('day', state.day);
  params.set('listPage', String(state.listPage));
  params.set('dayPage', String(state.dayPage));
  return `?${params.toString()}`;
}

export function validateLibraryBackTo(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/library') ||
    value.includes('\\') ||
    value.includes('#')
  ) {
    return null;
  }

  const origin = 'https://manga-nikki.invalid';
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }

  if (url.origin !== origin || url.pathname !== '/library' || url.hash) return null;
  if (!readAllowedValues(url.search)) return null;
  const parsed = parseLibrarySearch(url.search, '2000-01-01');
  return parsed ? `${url.pathname}${url.search}` : null;
}
