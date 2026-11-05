import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Entry } from '../../../shared/schemas';
import { jstToday } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';
import { ApiClientError, getEntries } from '../../lib/api';
import { EntryHistory } from './EntryHistory';
import {
  defaultLibrarySearch,
  maxListRestoreRequests,
  parseLibrarySearch,
  serializeLibrarySearch,
  type LibrarySearchState,
  type LibraryView,
} from './librarySearch';

const pageSize = 20;
const listPageSize = 3;
const dayPageSize = 2;
const weekDays = ['日', '月', '火', '水', '木', '金', '土'];
const firstMonth = '0001-01';
const lastMonth = '9999-12';

type EntryPage = { entries: Entry[]; cursor: string | null };
type ListCoverage = EntryPage & { reachedTarget: boolean };

function dateParts(value: string) {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}

function monthTitle(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  return `${year}年${month}月`;
}

function shiftMonth(value: string, amount: number) {
  const { year, month } = dateParts(`${value}-01`);
  const totalMonths = year * 12 + month - 1 + amount;
  const nextYear = Math.floor(totalMonths / 12);
  if (nextYear < 1 || nextYear > 9999) return value;
  const nextMonth = (totalMonths % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

function moveDateToMonth(value: string, targetMonth: string) {
  const lastDay = daysInMonth(targetMonth);
  const day = Math.min(dateParts(value).day, lastDay);
  return `${targetMonth}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function calendarDays(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  const firstDay = new Date(0);
  firstDay.setUTCFullYear(year, month - 1, 1);
  firstDay.setUTCHours(0, 0, 0, 0);
  const offset = firstDay.getUTCDay();
  const count = daysInMonth(value);
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return day < 1 || day > count ? null : `${value}-${String(day).padStart(2, '0')}`;
  });
}

function mergeEntries(current: Entry[], next: Entry[]) {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...next.filter((entry) => !seen.has(entry.id))];
}

function hasMonthCoverage(entries: Entry[], cursor: string | null, month: string) {
  if (!cursor) return true;
  const oldest = entries.at(-1);
  return oldest !== undefined && oldest.diaryDate < `${month}-01`;
}

async function fetchMonthCoverage(
  initialEntries: Entry[] | null,
  initialCursor: string | null,
  targetMonth: string,
  shouldContinue: () => boolean,
) {
  let entries = initialEntries;
  let cursor = initialCursor;

  if (entries === null) {
    const firstPage = await getEntries({ limit: pageSize });
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
    const page = await getEntries({ cursor, limit: pageSize });
    if (!shouldContinue()) return null;
    if (page.nextCursor === previousCursor) {
      throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
    }
    entries = mergeEntries(entries, page.items);
    cursor = page.nextCursor;
  }

  return { entries, cursor };
}

function targetEntryCount(page: number) {
  return page > Math.floor(Number.MAX_SAFE_INTEGER / listPageSize)
    ? Number.MAX_SAFE_INTEGER
    : page * listPageSize;
}

async function fetchListCoverage(
  initialEntries: Entry[],
  initialCursor: string | null,
  targetPage: number,
  shouldContinue: () => boolean,
  requestLimit = maxListRestoreRequests,
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
    const page = await getEntries({ cursor, limit: pageSize });
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

function isSessionUnavailable(error: unknown) {
  return (
    error instanceof ApiClientError &&
    (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED')
  );
}

function ListViewIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      focusable="false"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4" cy="6" r=".6" fill="currentColor" />
      <circle cx="4" cy="12" r=".6" fill="currentColor" />
      <circle cx="4" cy="18" r=".6" fill="currentColor" />
    </svg>
  );
}

function PageControls({
  page,
  canGoPrevious,
  canGoNext,
  busy,
  label,
  onPrevious,
  onNext,
}: {
  page: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  busy: boolean;
  label: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="library-page-controls" aria-label={label}>
      <button type="button" disabled={!canGoPrevious || busy} onClick={onPrevious}>
        前へ
      </button>
      <span aria-live="polite">{page}ページ目</span>
      <button type="button" disabled={!canGoNext || busy} onClick={onNext}>
        次へ
      </button>
    </nav>
  );
}

export function Library() {
  const [today] = useState(() => jstToday());
  const location = useLocation();
  const navigate = useNavigate();
  const parsedSearch = useMemo(
    () => parseLibrarySearch(location.search, today),
    [location.search, today],
  );
  const searchState = parsedSearch ?? defaultLibrarySearch(today);
  const canonicalSearch = serializeLibrarySearch(searchState);
  const initialSearchRef = useRef(searchState);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const entriesRef = useRef<Entry[] | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  const attemptedListRestoreRef = useRef<number | null>(null);
  const { view, month: visibleMonth, day: selectedDate, listPage, dayPage } = searchState;

  const updateSearch = useCallback(
    (patch: Partial<LibrarySearchState>) => {
      const current = parseLibrarySearch(location.search, today) ?? defaultLibrarySearch(today);
      navigate(
        { pathname: '/library', search: serializeLibrarySearch({ ...current, ...patch }) },
        { replace: true },
      );
    },
    [location.search, navigate, today],
  );

  useEffect(() => {
    if (location.pathname !== '/library' || location.search === canonicalSearch) return;
    navigate({ pathname: '/library', search: canonicalSearch }, { replace: true });
  }, [canonicalSearch, location.pathname, location.search, navigate]);

  const syncEntries = useCallback((items: Entry[], cursor: string | null) => {
    entriesRef.current = items;
    cursorRef.current = cursor;
    setEntries(items);
    setNextCursor(cursor);
  }, []);

  const loadThroughMonth = useCallback(
    async (targetMonth: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setBusy(true);

      try {
        const result = await fetchMonthCoverage(
          entriesRef.current,
          cursorRef.current,
          targetMonth,
          () => mountedRef.current,
        );
        if (!result || !mountedRef.current) return;
        syncEntries(result.entries, result.cursor);
      } catch (failure) {
        if (!mountedRef.current) return;
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録を読み込めませんでした。');
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [syncEntries],
  );

  const loadThroughListPage = useCallback(
    async (targetPage: number, requestLimit = maxListRestoreRequests) => {
      const current = entriesRef.current;
      const cursor = cursorRef.current;
      if (!current) return null;
      if (current.length >= targetEntryCount(targetPage) || !cursor) {
        return {
          entries: current,
          cursor,
          reachedTarget: current.length >= targetEntryCount(targetPage) || cursor === null,
        };
      }
      if (loadingRef.current) return null;

      loadingRef.current = true;
      setBusy(true);
      setError('');
      setSessionUnavailable(false);
      try {
        const result = await fetchListCoverage(
          current,
          cursor,
          targetPage,
          () => mountedRef.current,
          requestLimit,
        );
        if (!result || !mountedRef.current) return null;
        syncEntries(result.entries, result.cursor);
        return result;
      } catch (failure) {
        if (!mountedRef.current) return null;
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録の続きを取得できませんでした。');
        return null;
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [syncEntries],
  );

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    loadingRef.current = true;

    async function loadInitialEntries() {
      try {
        const result = await fetchMonthCoverage(
          null,
          null,
          initialSearchRef.current.month,
          () => active,
        );
        if (!active || !result) return;
        syncEntries(result.entries, result.cursor);
      } catch (failure) {
        if (!active) return;
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録を読み込めませんでした。');
      } finally {
        loadingRef.current = false;
        if (active) setBusy(false);
      }
    }

    void loadInitialEntries();
    return () => {
      active = false;
      mountedRef.current = false;
    };
  }, [syncEntries]);

  const entriesByDate = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries ?? []) {
      counts.set(entry.diaryDate, (counts.get(entry.diaryDate) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const dayEntries = useMemo(
    () => entries?.filter((entry) => entry.diaryDate === selectedDate) ?? [],
    [entries, selectedDate],
  );
  const monthCovered = hasMonthCoverage(entries ?? [], nextCursor, visibleMonth);
  const selectedPageCount = Math.ceil(dayEntries.length / dayPageSize);
  const activeDayPage = Math.min(dayPage, Math.max(1, selectedPageCount));
  const visibleDayEntries = dayEntries.slice(
    (activeDayPage - 1) * dayPageSize,
    activeDayPage * dayPageSize,
  );
  const listPageCount = Math.ceil((entries?.length ?? 0) / listPageSize);
  const activeListPage = Math.min(listPage, Math.max(1, listPageCount));
  const visibleListEntries = (entries ?? []).slice(
    (activeListPage - 1) * listPageSize,
    activeListPage * listPageSize,
  );
  const listRestorePending =
    view === 'list' && listPage > listPageCount && Boolean(nextCursor) && busy;

  useEffect(() => {
    if (entries === null || busy) return;
    const lastDayPage = Math.max(1, selectedPageCount);
    if (dayPage > lastDayPage) updateSearch({ dayPage: lastDayPage });
  }, [busy, dayPage, entries, selectedPageCount, updateSearch]);

  useEffect(() => {
    if (view !== 'list' || entries === null || busy) return;
    const loadedPages = Math.max(1, listPageCount);
    if (!nextCursor && listPage > loadedPages) {
      updateSearch({ listPage: loadedPages });
      return;
    }
    if (listPage <= listPageCount || !nextCursor || attemptedListRestoreRef.current === listPage) {
      return;
    }

    const targetPage = listPage;
    attemptedListRestoreRef.current = targetPage;
    void loadThroughListPage(targetPage).then((result) => {
      if (!result || !mountedRef.current) return;
      const loadedPageCount = Math.max(1, Math.ceil(result.entries.length / listPageSize));
      const targetHasEntries = result.entries.length > (targetPage - 1) * listPageSize;
      if (!result.reachedTarget && result.cursor) {
        setError(
          '記録が多いため、読み込めた続きのページを表示しています。次のページから読めます。',
        );
        updateSearch({ listPage: loadedPageCount });
      } else if (!targetHasEntries) {
        updateSearch({ listPage: loadedPageCount });
      }
    });
  }, [busy, entries, listPage, listPageCount, loadThroughListPage, nextCursor, updateSearch, view]);

  useEffect(() => {
    if (!monthCovered || busy || dayPage <= Math.max(1, selectedPageCount)) return;
    updateSearch({ dayPage: Math.max(1, selectedPageCount) });
  }, [busy, dayPage, monthCovered, selectedPageCount, updateSearch]);

  const backTo = `/library${serializeLibrarySearch(searchState)}`;

  function selectDate(date: string) {
    updateSearch({ day: date, dayPage: 1 });
  }

  function navigateMonth(amount: number) {
    const targetMonth = shiftMonth(visibleMonth, amount);
    if (targetMonth === visibleMonth || busy) return;
    updateSearch({
      month: targetMonth,
      day: moveDateToMonth(selectedDate, targetMonth),
      dayPage: 1,
    });
    setError('');
    setSessionUnavailable(false);
    void loadThroughMonth(targetMonth);
  }

  async function goToNextListPage() {
    if (!entries || !nextCursor || listPage >= Number.MAX_SAFE_INTEGER) return;
    const targetPage = listPage + 1;
    const loadedPages = Math.max(1, listPageCount);
    if (listPage < loadedPages) {
      updateSearch({ listPage: targetPage });
      return;
    }

    if (entries.length < listPage * listPageSize) {
      const result = await loadThroughListPage(listPage);
      if (result && !result.reachedTarget && result.cursor) {
        setError(
          '記録が多いため、読み込めた続きのページを表示しています。次のページから読めます。',
        );
      }
      return;
    }

    const result = await loadThroughListPage(targetPage);
    if (!result || !mountedRef.current) return;
    const loadedPageCount = Math.max(1, Math.ceil(result.entries.length / listPageSize));
    const targetHasEntries = result.entries.length > (targetPage - 1) * listPageSize;
    if (targetHasEntries) {
      updateSearch({ listPage: targetPage });
    } else if (!result.cursor) {
      updateSearch({ listPage: loadedPageCount });
    } else if (!result.reachedTarget) {
      setError('記録が多いため、読み込めた続きのページを表示しています。次のページから読めます。');
      updateSearch({ listPage: loadedPageCount });
    }
  }

  function retry() {
    setError('');
    setSessionUnavailable(false);
    if (view === 'list' && entriesRef.current && cursorRef.current) {
      attemptedListRestoreRef.current = null;
      void loadThroughListPage(Math.max(1, listPage));
    } else {
      void loadThroughMonth(visibleMonth);
    }
  }

  const selectedLabel = (() => {
    const { month, day } = dateParts(selectedDate);
    return `${month}月${day}日`;
  })();

  const calendarTabRef = useRef<HTMLButtonElement>(null);
  const listTabRef = useRef<HTMLButtonElement>(null);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextView: LibraryView | null = null;
    const currentView = event.currentTarget.id === 'library-calendar-tab' ? 'calendar' : 'list';
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextView = currentView === 'calendar' ? 'list' : 'calendar';
    } else if (event.key === 'Home') {
      nextView = 'calendar';
    } else if (event.key === 'End') {
      nextView = 'list';
    }
    if (!nextView) return;
    event.preventDefault();
    updateSearch({ view: nextView });
    (nextView === 'calendar' ? calendarTabRef : listTabRef).current?.focus();
  }

  function loadStateContent() {
    if (sessionUnavailable) {
      return (
        <div className="library-state-view">
          <div className="library-state-card">
            <Icon name="alert" size={44} />
            <h2>記録を表示できません</h2>
            <p>以前の記録にはアクセスできない状態です。</p>
          </div>
          <button type="button" className="library-secondary-button" onClick={retry}>
            もう一度読み込む
          </button>
          <Link className="library-primary-link" to="/new">
            <Icon name="plus" size={20} />
            <span>新しい日記を書く</span>
          </Link>
        </div>
      );
    }
    if (error) {
      return (
        <div className="library-state-view">
          <div className="library-state-card" role="alert">
            <Icon name="alert" size={44} />
            <h2>記録を読み込めません</h2>
            <p>{error}</p>
            <button type="button" className="library-secondary-button" onClick={retry}>
              もう一度読み込む
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="library-state-view">
        <div className="library-state-card" aria-live="polite">
          <output className="library-loading">記録を読み込んでいます…</output>
        </div>
      </div>
    );
  }

  return (
    <section className="library-page" aria-labelledby="library-title">
      <h1 className="sr-only" id="library-title">
        記録
      </h1>

      <div className="library-view-tabs" role="tablist" aria-label="記録の表示方法">
        <button
          ref={calendarTabRef}
          type="button"
          role="tab"
          id="library-calendar-tab"
          className="library-view-tab"
          aria-controls="library-calendar-panel"
          aria-selected={view === 'calendar'}
          tabIndex={view === 'calendar' ? 0 : -1}
          onClick={() => updateSearch({ view: 'calendar' })}
          onKeyDown={onTabKeyDown}
        >
          <Icon name="calendar" size={17} />
          <span>カレンダー</span>
        </button>
        <button
          ref={listTabRef}
          type="button"
          role="tab"
          id="library-list-tab"
          className="library-view-tab"
          aria-controls="library-list-panel"
          aria-selected={view === 'list'}
          tabIndex={view === 'list' ? 0 : -1}
          onClick={() => updateSearch({ view: 'list' })}
          onKeyDown={onTabKeyDown}
        >
          <ListViewIcon />
          <span>リスト</span>
        </button>
      </div>

      <div
        id="library-calendar-panel"
        className="library-tab-panel"
        role="tabpanel"
        aria-labelledby="library-calendar-tab"
        tabIndex={0}
        hidden={view !== 'calendar'}
      >
        {sessionUnavailable || entries === null ? (
          loadStateContent()
        ) : (
          <div className="library-calendar-view">
            <div className="library-month-toolbar">
              <button
                type="button"
                className="library-month-button"
                aria-label="前の月"
                disabled={busy || visibleMonth <= firstMonth}
                onClick={() => navigateMonth(-1)}
              >
                <Icon name="chevron-left" size={22} />
              </button>
              <h2 className="library-month-title">{monthTitle(visibleMonth)}</h2>
              <button
                type="button"
                className="library-month-button"
                aria-label="次の月"
                disabled={busy || visibleMonth >= lastMonth}
                onClick={() => navigateMonth(1)}
              >
                <Icon name="chevron-right" size={22} />
              </button>
            </div>

            <div className="library-inline-error" role={error ? 'alert' : undefined}>
              {error && (
                <>
                  <p>{error}</p>
                  <button type="button" className="library-secondary-button" onClick={retry}>
                    再試行
                  </button>
                </>
              )}
            </div>

            <output className="library-calendar-status" aria-live="polite">
              {!monthCovered &&
                (busy ? 'この月の記録を読み込んでいます…' : 'この月の記録を確認できません。')}
            </output>

            <table
              className="library-calendar"
              aria-label={`${monthTitle(visibleMonth)}のカレンダー`}
            >
              <thead>
                <tr>
                  {weekDays.map((weekDay) => (
                    <th scope="col" key={weekDay}>
                      {weekDay}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: days.length / 7 }, (_, weekIndex) => (
                  <tr key={`${visibleMonth}-week-${weekIndex}`}>
                    {days.slice(weekIndex * 7, weekIndex * 7 + 7).map((date, dayIndex) => {
                      if (!date)
                        return (
                          <td
                            key={`${visibleMonth}-blank-${weekIndex}-${dayIndex}`}
                            aria-hidden="true"
                          />
                        );
                      const count = monthCovered ? (entriesByDate.get(date) ?? 0) : 0;
                      const future = date > today;
                      const isSelected = date === selectedDate;
                      const { year, month, day } = dateParts(date);

                      return (
                        <td key={date}>
                          <button
                            type="button"
                            className={`library-day-button${future ? ' library-day-button--future' : ''}`}
                            aria-label={`${year}年${month}月${day}日${count ? `、記録${count}件` : ''}${future ? '、未来の日付' : ''}`}
                            aria-pressed={isSelected}
                            aria-current={date === today ? 'date' : undefined}
                            disabled={busy || !monthCovered}
                            onClick={() => selectDate(date)}
                          >
                            <span>{day}</span>
                            <span
                              className={`library-day-dot${count ? '' : ' library-day-dot--empty'}`}
                              aria-hidden="true"
                            />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <section className="library-day-section" aria-labelledby="library-selected-date">
              <h2 id="library-selected-date" className="library-day-heading">
                {selectedLabel}
                {monthCovered && dayEntries.length > 1 && <span>・{dayEntries.length}件</span>}
              </h2>
              {monthCovered && dayEntries.length > 0 ? (
                <div className="library-day-records">
                  <EntryHistory
                    entries={visibleDayEntries}
                    compact
                    showDate={false}
                    showStatus
                    backTo={backTo}
                  />
                </div>
              ) : monthCovered ? (
                <div className="library-day-empty">
                  <p>この日の記録はありません</p>
                  {selectedDate <= today && (
                    <Link className="library-day-create-link" to={`/new?date=${selectedDate}`}>
                      <Icon name="plus" size={20} />
                      <span>この日の日記を書く</span>
                    </Link>
                  )}
                </div>
              ) : (
                <output className="library-day-unavailable" aria-live="polite">
                  {busy ? '記録を読み込んでいます…' : '記録の全件を確認できません。'}
                  {!busy && (
                    <button type="button" className="library-text-button" onClick={retry}>
                      もう一度読み込む
                    </button>
                  )}
                </output>
              )}
              {monthCovered && dayEntries.length > 0 && selectedPageCount > 1 && (
                <PageControls
                  page={activeDayPage}
                  canGoPrevious={activeDayPage > 1}
                  canGoNext={activeDayPage < selectedPageCount}
                  busy={busy}
                  label="選択日の記録のページ送り"
                  onPrevious={() => updateSearch({ dayPage: Math.max(1, activeDayPage - 1) })}
                  onNext={() => updateSearch({ dayPage: activeDayPage + 1 })}
                />
              )}
            </section>
          </div>
        )}
      </div>

      <div
        id="library-list-panel"
        className="library-tab-panel"
        role="tabpanel"
        aria-labelledby="library-list-tab"
        tabIndex={0}
        hidden={view !== 'list'}
      >
        {sessionUnavailable || entries === null ? (
          loadStateContent()
        ) : (
          <div className="library-list-view">
            <div className="library-inline-error" role={error ? 'alert' : undefined}>
              {error && (
                <>
                  <p>{error}</p>
                  <button type="button" className="library-secondary-button" onClick={retry}>
                    再試行
                  </button>
                </>
              )}
            </div>
            {listRestorePending ? (
              <div className="library-list-loading" aria-live="polite">
                指定したページの記録を読み込んでいます…
              </div>
            ) : visibleListEntries.length > 0 ? (
              <div className="library-list-records">
                <EntryHistory
                  entries={visibleListEntries}
                  monthHeadings
                  showStatus
                  backTo={backTo}
                />
              </div>
            ) : entries.length === 0 && !nextCursor ? (
              <div className="library-list-empty-state">
                <Icon name="book" size={48} />
                <h2>まだ記録がありません</h2>
                <p>日記を書くとここに並びます</p>
                <Link className="library-primary-link" to="/new">
                  <Icon name="plus" size={20} />
                  <span>日記を書く</span>
                </Link>
              </div>
            ) : (
              <div className="library-list-empty" aria-live="polite">
                {busy ? '記録を読み込んでいます…' : '記録を表示できません。再試行してください。'}
              </div>
            )}
            {visibleListEntries.length > 0 && !listRestorePending && (
              <PageControls
                page={activeListPage}
                canGoPrevious={activeListPage > 1}
                canGoNext={activeListPage < listPageCount || Boolean(nextCursor)}
                busy={busy}
                label="記録一覧のページ送り"
                onPrevious={() => updateSearch({ listPage: Math.max(1, activeListPage - 1) })}
                onNext={() => void goToNextListPage()}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
