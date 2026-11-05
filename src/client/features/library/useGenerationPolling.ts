import { useLayoutEffect, useEffect, useRef, type RefObject } from 'react';
import type { Generation } from '../../../shared/schemas';
import { getGeneration } from '../../lib/api';

export function useGenerationPolling(
  generation: Generation | null | undefined,
  activeRef: RefObject<boolean>,
  applyGeneration: (generation: Generation) => void,
  setError: (message: string) => void,
  refreshQuota: () => Promise<unknown>,
) {
  const pending = generation?.status === 'queued' || generation?.status === 'running';
  const callbacks = useRef({ applyGeneration, setError, refreshQuota });
  useLayoutEffect(() => {
    callbacks.current = { applyGeneration, setError, refreshQuota };
  }, [applyGeneration, setError, refreshQuota]);
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
          callbacks.current.setError('');
          if (result.status !== 'queued' && result.status !== 'running')
            void callbacks.current.refreshQuota();
        }
      } catch (failure) {
        if (active && activeRef.current)
          callbacks.current.setError(
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
