import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import type { Entry } from '../../../shared/schemas';
import { jstToday } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';
import { ApiClientError, getEntries } from '../../lib/api';
import { EntryHistory } from './EntryHistory';

const pageSize = 20;
const listPageSize = 3;
const dayPageSize = 2;
const weekDays = ['日', '月', '火', '水', '木', '金', '土'];

type LibraryProps = {
  setHeaderAction: (action: ReactNode | null) => void;
};

function dateParts(value: string) {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function monthTitle(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  return `${year}年${month}月`;
}

function shiftMonth(value: string, amount: number) {
  const { year, month } = dateParts(`${value}-01`);
  const next = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

function moveDateToMonth(value: string, targetMonth: string) {
  const { year, month } = dateParts(`${targetMonth}-01`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(dateParts(value).day, lastDay);
  return `${targetMonth}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function calendarDays(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  const offset = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
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

  while (!hasMonthCoverage(entries, cursor, targetMonth) && cursor) {
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

function isSessionUnavailable(error: unknown) {
  return (
    error instanceof ApiClientError &&
    (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED')
  );
}

function ListViewIcon() {
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
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
      <span aria-live="polite">{page + 1}ページ目</span>
      <button type="button" disabled={!canGoNext || busy} onClick={onNext}>
        次へ
      </button>
    </nav>
  );
}

export function Library({ setHeaderAction }: LibraryProps) {
  const [today] = useState(() => jstToday());
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [visibleMonth, setVisibleMonth] = useState(() => monthKey(today));
  const [selectedDate, setSelectedDate] = useState(() => today);
  const [listPage, setListPage] = useState(0);
  const [dayPage, setDayPage] = useState(0);

  const entriesRef = useRef<Entry[] | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  const currentMonth = monthKey(today);
  const headerAction = useMemo(
    () => (
      <button
        type="button"
        className="library-view-toggle"
        aria-label={view === 'calendar' ? '一覧で見る' : 'カレンダーで見る'}
        aria-pressed={view === 'list'}
        onClick={() => setView((current) => (current === 'calendar' ? 'list' : 'calendar'))}
      >
        {view === 'calendar' ? <ListViewIcon /> : <Icon name="calendar" />}
      </button>
    ),
    [view],
  );

  useLayoutEffect(() => {
    setHeaderAction(headerAction);
    return () => setHeaderAction(null);
  }, [headerAction, setHeaderAction]);

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

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    async function loadInitialEntries() {
      loadingRef.current = true;
      try {
        const result = await fetchMonthCoverage(null, null, currentMonth, () => active);
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
  }, [currentMonth, syncEntries]);

  const dayEntries = useMemo(
    () => entries?.filter((entry) => entry.diaryDate === selectedDate) ?? [],
    [entries, selectedDate],
  );
  const entriesByDate = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries ?? []) {
      counts.set(entry.diaryDate, (counts.get(entry.diaryDate) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const monthCovered = hasMonthCoverage(entries ?? [], nextCursor, visibleMonth);
  async function loadMore() {
    const cursor = cursorRef.current;
    const current = entriesRef.current;
    if (!cursor || current === null || loadingRef.current) return false;
    loadingRef.current = true;
    setBusy(true);
    setError('');
    setSessionUnavailable(false);
    try {
      const page = await getEntries({ cursor, limit: pageSize });
      if (!mountedRef.current) return;
      if (page.nextCursor === cursor) {
        throw new Error('記録の続きを読み込めませんでした。再度お試しください。');
      }
      syncEntries(mergeEntries(current, page.items), page.nextCursor);
      return true;
    } catch (failure) {
      if (!mountedRef.current) return;
      if (isSessionUnavailable(failure)) setSessionUnavailable(true);
      setError(failure instanceof Error ? failure.message : '記録の続きを取得できませんでした。');
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
    return false;
  }

  function retry() {
    setBusy(true);
    setError('');
    setSessionUnavailable(false);
    if (view === 'list' && entriesRef.current !== null && cursorRef.current) {
      void loadMore();
    } else {
      void loadThroughMonth(visibleMonth);
    }
  }

  function goToNextListPage() {
    const loadedPages = Math.ceil((entries?.length ?? 0) / listPageSize);
    if (listPage + 1 < loadedPages) {
      setListPage((page) => page + 1);
      return;
    }
    if (!nextCursor || !entries) return;
    const pageIsFull = entries.length % listPageSize === 0;
    void loadMore().then((loaded) => {
      if (loaded && pageIsFull) setListPage((page) => page + 1);
    });
  }

  function selectDate(date: string) {
    setSelectedDate(date);
    setDayPage(0);
  }

  function navigateMonth(amount: number) {
    const targetMonth = shiftMonth(visibleMonth, amount);
    if (targetMonth > currentMonth || busy) return;
    setVisibleMonth(targetMonth);
    setSelectedDate(moveDateToMonth(selectedDate, targetMonth));
    setDayPage(0);
    setBusy(true);
    setError('');
    setSessionUnavailable(false);
    void loadThroughMonth(targetMonth);
  }

  const selectedLabel = (() => {
    const { month, day } = dateParts(selectedDate);
    return `${month}月${day}日`;
  })();
  const selectedPageCount = Math.ceil(dayEntries.length / dayPageSize);
  const activeDayPage = Math.min(dayPage, Math.max(0, selectedPageCount - 1));
  const visibleDayEntries = dayEntries.slice(
    activeDayPage * dayPageSize,
    (activeDayPage + 1) * dayPageSize,
  );
  const listPageCount = Math.ceil((entries?.length ?? 0) / listPageSize);
  const activeListPage = Math.min(listPage, Math.max(0, listPageCount - 1));
  const visibleListEntries = (entries ?? []).slice(
    activeListPage * listPageSize,
    (activeListPage + 1) * listPageSize,
  );

  return (
    <section className="library-page" aria-labelledby="library-title">
      <h1 className="sr-only" id="library-title">
        記録
      </h1>

      {sessionUnavailable ? (
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
      ) : entries === null ? (
        <div className="library-state-view">
          <div className="library-state-card" aria-live="polite">
            {error ? (
              <>
                <Icon name="alert" size={44} />
                <h2>記録を読み込めません</h2>
                <p>{error}</p>
                <button type="button" className="library-secondary-button" onClick={retry}>
                  もう一度読み込む
                </button>
              </>
            ) : (
              <output className="library-loading">記録を読み込んでいます…</output>
            )}
          </div>
        </div>
      ) : entries.length === 0 && !nextCursor ? (
        <div className="library-state-view">
          <div className="library-state-card">
            <Icon name="book" size={52} />
            <h2>まだ記録がありません</h2>
            <p>日記を書くとここに並びます</p>
          </div>
          <Link className="library-primary-link" to="/new">
            <Icon name="plus" size={20} />
            <span>日記を書く</span>
          </Link>
        </div>
      ) : view === 'calendar' ? (
        <div className="library-calendar-view">
          <div className="library-month-toolbar">
            <button
              type="button"
              className="library-month-button"
              aria-label="前の月"
              disabled={busy}
              onClick={() => navigateMonth(-1)}
            >
              <Icon name="chevron-left" size={22} />
            </button>
            <h2 className="library-month-title">{monthTitle(visibleMonth)}</h2>
            <button
              type="button"
              className="library-month-button"
              aria-label="次の月"
              disabled={busy || visibleMonth >= currentMonth}
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
                    const { day } = dateParts(date);

                    return (
                      <td key={date}>
                        <button
                          type="button"
                          className="library-day-button"
                          aria-label={`${dateParts(date).year}年${dateParts(date).month}月${day}日${count ? `、記録${count}件` : ''}${future ? '、未来の日付' : ''}`}
                          aria-pressed={isSelected}
                          aria-current={date === today ? 'date' : undefined}
                          disabled={busy || !monthCovered}
                          onClick={() => selectDate(date)}
                        >
                          <span>{day}</span>
                          {count > 0 && <span className="library-day-dot" aria-hidden="true" />}
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
                <EntryHistory entries={visibleDayEntries} compact showDate={false} />
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
            {monthCovered && dayEntries.length > 0 ? (
              <PageControls
                page={activeDayPage}
                canGoPrevious={activeDayPage > 0}
                canGoNext={activeDayPage + 1 < selectedPageCount}
                busy={busy}
                label="選択日の記録のページ送り"
                onPrevious={() => setDayPage((page) => Math.max(0, page - 1))}
                onNext={() => setDayPage((page) => page + 1)}
              />
            ) : (
              <div
                className="library-page-controls library-page-controls--placeholder"
                aria-hidden="true"
              />
            )}
          </section>
        </div>
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
          {visibleListEntries.length > 0 ? (
            <div className="library-list-records">
              <EntryHistory entries={visibleListEntries} />
            </div>
          ) : (
            <div className="library-list-empty" aria-live="polite">
              {busy ? '記録を読み込んでいます…' : '記録を表示できません。再試行してください。'}
            </div>
          )}
          <PageControls
            page={activeListPage}
            canGoPrevious={activeListPage > 0}
            canGoNext={activeListPage + 1 < listPageCount || Boolean(nextCursor)}
            busy={busy}
            label="記録一覧のページ送り"
            onPrevious={() => setListPage((page) => Math.max(0, page - 1))}
            onNext={goToNextListPage}
          />
        </div>
      )}
    </section>
  );
}
