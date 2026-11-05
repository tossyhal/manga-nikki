import { useLayoutEffect, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Generation } from '../../../shared/schemas';
import { getGeneration, getQuotaForExistingSession, type GenerationQuota } from '../../lib/api';
import type { ClientConfig } from '../../lib/config';

export type QuotaState = 'loading' | 'ready' | 'session-required' | 'unavailable';

export function quotaAllowsGeneration(quota: GenerationQuota | null): boolean {
  return Boolean(
    quota &&
    quota.generationAvailable &&
    quota.remainingToday > 0 &&
    quota.activeGenerationId === null,
  );
}

export function useGenerationQuota({
  dataMode,
  activeRef,
  markLoading,
  onActiveGeneration,
}: {
  dataMode: ClientConfig['dataMode'];
  activeRef: RefObject<boolean>;
  markLoading: boolean;
  onActiveGeneration?: (generation: Generation) => void;
}) {
  const [quota, setQuota] = useState<GenerationQuota | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<Generation | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const quotaRequestRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<GenerationQuota | null> | null>(null);
  const lastAutomaticRefreshAtRef = useRef(0);
  const onActiveRef = useRef(onActiveGeneration);
  useLayoutEffect(() => {
    onActiveRef.current = onActiveGeneration;
  }, [onActiveGeneration]);
  const refreshQuota = useCallback((): Promise<GenerationQuota | null> => {
    if (!activeRef.current) return Promise.resolve(null);
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const requestId = ++quotaRequestRef.current;
    if (markLoading) setQuotaState('loading');
    setRefreshing(true);
    const request = (async () => {
      try {
        const currentQuota = await getQuotaForExistingSession();
        if (!activeRef.current || requestId !== quotaRequestRef.current) return null;
        setQuota(currentQuota);
        if (!currentQuota) {
          setActiveGeneration(null);
          setQuotaState(dataMode === 'live' ? 'session-required' : 'unavailable');
          return null;
        }
        setQuotaState('ready');
        if (currentQuota.activeGenerationId) {
          const current = await getGeneration(currentQuota.activeGenerationId).catch(() => null);
          if (activeRef.current && requestId === quotaRequestRef.current) {
            setActiveGeneration(current);
            if (current) onActiveRef.current?.(current);
          }
        } else {
          setActiveGeneration(null);
        }
        return currentQuota;
      } catch {
        if (activeRef.current && requestId === quotaRequestRef.current) {
          setQuota(null);
          setActiveGeneration(null);
          setQuotaState('unavailable');
        }
        return null;
      } finally {
        refreshPromiseRef.current = null;
        if (activeRef.current && requestId === quotaRequestRef.current) setRefreshing(false);
      }
    })();
    refreshPromiseRef.current = request;
    return request;
  }, [dataMode, activeRef, markLoading]);

  useEffect(() => {
    const resetAt = Date.parse(quota?.resetAt ?? '');
    if (!Number.isFinite(resetAt) || resetAt <= Date.now()) return;
    const delay = Math.min(resetAt - Date.now() + 1000, 2_147_000_000);
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refreshQuota();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [quota?.resetAt, refreshQuota]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastAutomaticRefreshAtRef.current < 1000) return;
      lastAutomaticRefreshAtRef.current = now;
      void refreshQuota();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenVisible);
    window.addEventListener('online', refreshWhenVisible);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenVisible);
    };
  }, [refreshQuota]);

  return {
    quota,
    activeGeneration,
    quotaState,
    refreshing,
    setQuotaState,
    setActiveGeneration,
    refreshQuota,
  };
}
