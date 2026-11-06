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

function isMissingLocalSession(error: unknown) {
  return (
    error instanceof ApiClientError &&
    error.status === 401 &&
    error.code === 'AUTH_REQUIRED' &&
    error.requestId === null
  );
}

type ActiveRequest = { epoch: number; controller: AbortController };

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
  const requestEpochRef = useRef(0);
  const activeRequestRef = useRef<ActiveRequest | null>(null);

  const syncEntries = useCallback((items: Entry[] | null, cursor: string | null) => {
    entriesRef.current = items;
    cursorRef.current = cursor;
    setEntries(items);
    setNextCursor(cursor);
  }, []);

  const beginRequest = useCallback(() => {
    activeRequestRef.current?.controller.abort();
    const request = {
      epoch: ++requestEpochRef.current,
      controller: new AbortController(),
    };
    activeRequestRef.current = request;
    loadingRef.current = true;
    setBusy(true);
    return request;
  }, []);

  const requestIsActive = useCallback(
    (request: ActiveRequest) =>
      mountedRef.current && activeRequestRef.current?.epoch === request.epoch,
    [],
  );

  const finishRequest = useCallback((request: ActiveRequest) => {
    if (activeRequestRef.current?.epoch !== request.epoch) return;
    activeRequestRef.current = null;
    loadingRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, []);

  const refreshEntries = useCallback(
    async (targetMonth: string) => {
      const request = beginRequest();
      syncEntries(null, null);
      setError('');
      setSessionUnavailable(false);

      try {
        const result = await fetchMonthCoverage(
          null,
          null,
          targetMonth,
          () => requestIsActive(request),
          request.controller.signal,
          (items, cursor) => {
            if (requestIsActive(request)) syncEntries(items, cursor);
          },
        );
        if (!result || !requestIsActive(request)) return;
        syncEntries(result.entries, result.cursor);
      } catch (failure) {
        if (!requestIsActive(request)) return;
        if (navigator.onLine && entriesRef.current === null && isMissingLocalSession(failure)) {
          syncEntries([], null);
          return;
        }
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録を読み込めませんでした。');
      } finally {
        finishRequest(request);
      }
    },
    [beginRequest, finishRequest, requestIsActive, syncEntries],
  );

  const loadThroughMonth = useCallback(
    async (targetMonth: string) => {
      if (loadingRef.current) return;
      const request = beginRequest();

      try {
        const result = await fetchMonthCoverage(
          entriesRef.current,
          cursorRef.current,
          targetMonth,
          () => requestIsActive(request),
          request.controller.signal,
          (items, cursor) => {
            if (requestIsActive(request)) syncEntries(items, cursor);
          },
        );
        if (!result || !requestIsActive(request)) return;
        syncEntries(result.entries, result.cursor);
      } catch (failure) {
        if (!requestIsActive(request)) return;
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録を読み込めませんでした。');
      } finally {
        finishRequest(request);
      }
    },
    [beginRequest, finishRequest, requestIsActive, syncEntries],
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

      const request = beginRequest();
      setError('');
      setSessionUnavailable(false);
      try {
        const result = await fetchListCoverage(
          current,
          cursor,
          targetPage,
          () => requestIsActive(request),
          requestLimit,
          request.controller.signal,
        );
        if (!result || !requestIsActive(request)) return null;
        syncEntries(result.entries, result.cursor);
        return result;
      } catch (failure) {
        if (!requestIsActive(request)) return null;
        if (isSessionUnavailable(failure)) setSessionUnavailable(true);
        setError(failure instanceof Error ? failure.message : '記録の続きを取得できませんでした。');
        return null;
      } finally {
        finishRequest(request);
      }
    },
    [beginRequest, finishRequest, requestIsActive, syncEntries],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshEntries(initialMonthRef.current);

    return () => {
      mountedRef.current = false;
      const activeRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      loadingRef.current = false;
      activeRequest?.controller.abort();
    };
  }, [refreshEntries]);

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
    refreshEntries,
    mountedRef,
  };
}
