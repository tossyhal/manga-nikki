import { useLayoutEffect, useEffect, useRef, type RefObject } from 'react';
import type { Generation } from '../../../shared/schemas';
import { getGeneration } from '../../lib/api';

export function useGenerationPolling(
  generation: Generation | null | undefined,
  activeRef: RefObject<boolean>,
  applyGeneration: (generation: Generation) => void,
  setPollingError: (message: string) => void,
  refreshQuota: (options?: { fresh?: boolean }) => Promise<unknown>,
) {
  const pending = generation?.status === 'queued' || generation?.status === 'running';
  const callbacks = useRef({ applyGeneration, setPollingError, refreshQuota });
  useLayoutEffect(() => {
    callbacks.current = { applyGeneration, setPollingError, refreshQuota };
  }, [applyGeneration, setPollingError, refreshQuota]);
  useEffect(() => {
    const generationId = generation?.id;
    if (!pending || !generationId) return;
    let active = true;
    let fetching = false;
    async function refresh() {
      if (document.hidden || fetching) return;
      fetching = true;
      try {
        const result = await getGeneration(generationId!);
        if (active && activeRef.current) {
          callbacks.current.applyGeneration(result);
          callbacks.current.setPollingError('');
          if (result.status !== 'queued' && result.status !== 'running')
            void callbacks.current.refreshQuota({ fresh: true });
        }
      } catch (failure) {
        if (active && activeRef.current)
          callbacks.current.setPollingError(
            failure instanceof Error ? failure.message : '状態を取得できません。',
          );
      } finally {
        fetching = false;
      }
    }
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => {
      void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [generation?.id, pending, refreshQuota, activeRef]);
}
