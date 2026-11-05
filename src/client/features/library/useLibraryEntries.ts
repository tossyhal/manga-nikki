import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry } from '../../../shared/schemas';
import { ApiClientError } from '../../lib/api';
import { fetchMonthCoverage, fetchListCoverage, targetEntryCount } from './libraryCoverage';
import { maxListRestoreRequests } from './librarySearch';

function isSessionUnavailable(error: unknown) {
  return (
    error instanceof ApiClientError &&
    (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED')
  );
}

export function useLibraryEntries(initialMonth: string) {
  const initialMonthRef = useRef(initialMonth);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const entriesRef = useRef<Entry[] | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
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
        const result = await fetchMonthCoverage(null, null, initialMonthRef.current, () => active);
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

  return {
    entries,
    nextCursor,
    busy,
    error,
    sessionUnavailable,
    setError,
    setSessionUnavailable,
    loadThroughMonth,
    loadThroughListPage,
    mountedRef,
  };
}
