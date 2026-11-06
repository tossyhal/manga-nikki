import { useLayoutEffect, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Generation } from '../../../shared/schemas';
import { getGeneration, getQuotaForExistingSession, type GenerationQuota } from '../../lib/api';
import type { ClientConfig } from '../../lib/config';
import { preserveGenerationProgress } from '../library/generationProgress';

export type QuotaState = 'loading' | 'ready' | 'session-required' | 'unavailable';
export type QuotaRefreshOptions = { fresh?: boolean; afterResetAt?: number };

type QuotaRefreshRequest = {
  id: number;
  startedAt: number;
  promise: Promise<GenerationQuota | null>;
  afterResetAt?: number;
  afterResetPromise?: Promise<GenerationQuota | null>;
};

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
  generationAvailable,
  activeRef,
  markLoading,
  onActiveGeneration,
}: {
  dataMode: ClientConfig['dataMode'];
  generationAvailable: ClientConfig['generationAvailable'];
  activeRef: RefObject<boolean>;
  markLoading: boolean;
  onActiveGeneration?: (generation: Generation) => void;
}) {
  const [quota, setQuota] = useState<GenerationQuota | null>(null);
  const [activeGeneration, setActiveGenerationState] = useState<Generation | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const quotaRequestRef = useRef(0);
  const refreshRequestRef = useRef<QuotaRefreshRequest | null>(null);
  const refreshQuotaRef = useRef<
    (options?: QuotaRefreshOptions) => Promise<GenerationQuota | null>
  >(() => Promise.resolve(null));
  const activeGenerationRef = useRef<Generation | null>(null);
  const lastAutomaticRefreshAtRef = useRef(0);
  const previousConfigRef = useRef({ dataMode, generationAvailable });
  const onActiveRef = useRef(onActiveGeneration);
  useLayoutEffect(() => {
    onActiveRef.current = onActiveGeneration;
  }, [onActiveGeneration]);
  const updateActiveGeneration = useCallback((incoming: Generation | null) => {
    const current = activeGenerationRef.current;
    const next = current && incoming ? preserveGenerationProgress(current, incoming) : incoming;
    activeGenerationRef.current = next;
    setActiveGenerationState(next);
    return next;
  }, []);
  const refreshQuota = useCallback(
    (options: QuotaRefreshOptions = {}): Promise<GenerationQuota | null> => {
      if (!activeRef.current) return Promise.resolve(null);
      const currentRequest = refreshRequestRef.current;
      if (
        options.afterResetAt !== undefined &&
        currentRequest &&
        currentRequest.startedAt < options.afterResetAt
      ) {
        if (
          currentRequest.afterResetAt === options.afterResetAt &&
          currentRequest.afterResetPromise
        )
          return currentRequest.afterResetPromise;
        const afterResetPromise = currentRequest.promise.then(() => {
          if (!activeRef.current) return null;
          const newerRequest = refreshRequestRef.current;
          if (newerRequest) {
            return newerRequest.startedAt >= options.afterResetAt!
              ? newerRequest.promise
              : refreshQuotaRef.current({ afterResetAt: options.afterResetAt });
          }
          if (quotaRequestRef.current !== currentRequest.id) return null;
          return refreshQuotaRef.current();
        });
        currentRequest.afterResetAt = options.afterResetAt;
        currentRequest.afterResetPromise = afterResetPromise;
        return afterResetPromise;
      }
      if (!options.fresh && currentRequest) return currentRequest.promise;
      const requestId = ++quotaRequestRef.current;
      const startedAt = Date.now();
      if (markLoading) setQuotaState('loading');
      setRefreshing(true);
      const request = (async () => {
        try {
          const currentQuota = await getQuotaForExistingSession();
          if (!activeRef.current || requestId !== quotaRequestRef.current) return null;
          const responseResetAt = Date.parse(currentQuota?.resetAt ?? '');
          if (
            Number.isFinite(responseResetAt) &&
            startedAt < responseResetAt &&
            responseResetAt <= Date.now()
          )
            void refreshQuotaRef.current({ afterResetAt: responseResetAt });
          setQuota(currentQuota);
          if (!currentQuota) {
            updateActiveGeneration(null);
            setQuotaState(dataMode === 'live' ? 'session-required' : 'unavailable');
            return null;
          }
          setQuotaState('ready');
          if (currentQuota.activeGenerationId) {
            const current = await getGeneration(currentQuota.activeGenerationId).catch(() => null);
            if (activeRef.current && requestId === quotaRequestRef.current) {
              if (current) {
                const next = updateActiveGeneration(current);
                onActiveRef.current?.(next ?? current);
              } else if (activeGenerationRef.current?.id !== currentQuota.activeGenerationId) {
                updateActiveGeneration(null);
              }
            }
          } else {
            updateActiveGeneration(null);
          }
          return currentQuota;
        } catch {
          if (activeRef.current && requestId === quotaRequestRef.current) {
            setQuota(null);
            updateActiveGeneration(null);
            setQuotaState('unavailable');
          }
          return null;
        } finally {
          if (refreshRequestRef.current?.id === requestId) {
            refreshRequestRef.current = null;
            if (activeRef.current && requestId === quotaRequestRef.current) setRefreshing(false);
          }
        }
      })();
      refreshRequestRef.current = { id: requestId, startedAt, promise: request };
      return request;
    },
    [dataMode, activeRef, markLoading, updateActiveGeneration],
  );
  useLayoutEffect(() => {
    refreshQuotaRef.current = refreshQuota;
  }, [refreshQuota]);

  useEffect(() => {
    const previousConfig = previousConfigRef.current;
    previousConfigRef.current = { dataMode, generationAvailable };
    if (
      previousConfig.dataMode === dataMode &&
      previousConfig.generationAvailable !== generationAvailable
    )
      void refreshQuota({ fresh: true });
  }, [dataMode, generationAvailable, refreshQuota]);

  useEffect(() => {
    const resetAt = Date.parse(quota?.resetAt ?? '');
    if (!Number.isFinite(resetAt) || resetAt <= Date.now()) return;
    const delay = Math.min(resetAt - Date.now() + 1000, 2_147_000_000);
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && navigator.onLine)
        void refreshQuota({ afterResetAt: resetAt });
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
    setActiveGeneration: updateActiveGeneration,
    refreshQuota,
  };
}
