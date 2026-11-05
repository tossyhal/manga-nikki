import { useLibraryEntries } from './useLibraryEntries';
import {
  dateParts,
  monthTitle,
  shiftMonth,
  moveDateToMonth,
  calendarDays,
} from './libraryCalendar';
import { hasMonthCoverage, targetEntryCount, listPageSize, dayPageSize } from './libraryCoverage';
import { PageControls } from './LibraryPageControls';
import { LibraryViewTabs } from './LibraryViewTabs';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Icon } from '../../app/Icon';
import { useJstToday } from '../../lib/useJstToday';
import { EntryHistory } from './EntryHistory';
import {
  defaultLibrarySearch,
  parseLibrarySearch,
  serializeLibrarySearch,
  type LibrarySearchState,
} from './librarySearch';

const weekDays = ['日', '月', '火', '水', '木', '金', '土'];
const firstMonth = '0001-01';
const lastMonth = '9999-12';

export function Library() {
  const today = useJstToday();
  const location = useLocation();
  const navigate = useNavigate();
  const parsedSearch = useMemo(
    () => parseLibrarySearch(location.search, today),
    [location.search, today],
  );
  const searchState = useMemo(
    () => parsedSearch ?? defaultLibrarySearch(today),
    [parsedSearch, today],
  );
  const canonicalSearch = serializeLibrarySearch(searchState);
  const latestSearchRef = useRef(searchState);
  const attemptedListRestoreRef = useRef<number | null>(null);
  const {
    entries,
    nextCursor,
    busy,
    error,
    sessionUnavailable,
    setError,
    setSessionUnavailable,
    loadThroughMonth,
    loadThroughListPage,
    refreshEntries,
    mountedRef,
  } = useLibraryEntries(searchState.month);
  const { view, month: visibleMonth, day: selectedDate, listPage, dayPage } = searchState;

  useLayoutEffect(() => {
    latestSearchRef.current = searchState;
  }, [searchState]);

  const updateSearch = useCallback(
    (patch: Partial<LibrarySearchState>) => {
      const next = { ...latestSearchRef.current, ...patch };
      latestSearchRef.current = next;
      navigate({ pathname: '/library', search: serializeLibrarySearch(next) }, { replace: true });
    },
    [navigate],
  );

  useEffect(() => {
    if (location.pathname !== '/library' || location.search === canonicalSearch) return;
    navigate({ pathname: '/library', search: canonicalSearch }, { replace: true });
  }, [canonicalSearch, location.pathname, location.search, navigate]);

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
    view === 'list' &&
    entries !== null &&
    Boolean(nextCursor) &&
    entries.length < targetEntryCount(listPage) &&
    busy;

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
    if (
      entries.length >= targetEntryCount(listPage) ||
      !nextCursor ||
      attemptedListRestoreRef.current === listPage
    ) {
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
  }, [
    busy,
    entries,
    listPage,
    listPageCount,
    loadThroughListPage,
    nextCursor,
    updateSearch,
    view,
    setError,
    mountedRef,
  ]);

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
    if (!entries || listPage >= Number.MAX_SAFE_INTEGER) return;

    if (nextCursor && entries.length < targetEntryCount(listPage)) {
      const result = await loadThroughListPage(listPage);
      if (result && !result.reachedTarget && result.cursor) {
        setError(
          '記録が多いため、読み込めた続きのページを表示しています。次のページから読めます。',
        );
      }
      return;
    }

    const targetPage = listPage + 1;
    if (
      entries.length >= targetEntryCount(targetPage) ||
      (!nextCursor && targetPage <= Math.max(1, listPageCount))
    ) {
      updateSearch({ listPage: targetPage });
      return;
    }
    if (!nextCursor) return;

    const result = await loadThroughListPage(targetPage);
    if (!result || !mountedRef.current) return;
    const loadedPageCount = Math.max(1, Math.ceil(result.entries.length / listPageSize));
    const targetHasEntries = result.entries.length > (targetPage - 1) * listPageSize;
    const targetPageCovered =
      result.entries.length >= targetEntryCount(targetPage) || result.cursor === null;
    if (targetHasEntries && targetPageCovered) {
      updateSearch({ listPage: targetPage });
    } else if (!result.reachedTarget) {
      setError('記録が多いため、読み込めた続きのページを表示しています。次のページから読めます。');
      if (!targetHasEntries) updateSearch({ listPage: loadedPageCount });
    }
  }

  function retry() {
    setError('');
    setSessionUnavailable(false);
    if (view === 'list' && entries && nextCursor) {
      attemptedListRestoreRef.current = null;
      void loadThroughListPage(Math.max(1, listPage));
    } else {
      void loadThroughMonth(visibleMonth);
    }
  }

  function refresh() {
    attemptedListRestoreRef.current = null;
    updateSearch({ listPage: 1, dayPage: 1 });
    void refreshEntries(visibleMonth);
  }

  const selectedLabel = (() => {
    const { month, day } = dateParts(selectedDate);
    return `${month}月${day}日`;
  })();

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

      <div className="library-view-toolbar">
        <LibraryViewTabs view={view} onChange={(view) => updateSearch({ view })} />
        <button
          type="button"
          className="library-refresh-button"
          aria-label="記録を再読み込み"
          aria-busy={busy}
          onClick={refresh}
        >
          <Icon name="refresh" size={20} />
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
