import { useLayoutEffect, useCallback, useRef, useState, type RefObject } from 'react';
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
  const quotaRequestRef = useRef(0);
  const onActiveRef = useRef(onActiveGeneration);
  useLayoutEffect(() => {
    onActiveRef.current = onActiveGeneration;
  }, [onActiveGeneration]);
  const refreshQuota = useCallback(async (): Promise<GenerationQuota | null> => {
    const requestId = ++quotaRequestRef.current;
    if (!activeRef.current) return null;
    if (markLoading) setQuotaState('loading');
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
    }
  }, [dataMode, activeRef, markLoading]);

  return { quota, activeGeneration, quotaState, setQuotaState, setActiveGeneration, refreshQuota };
}
