import { useEffect, useState } from 'react';

export function useDelayedLoading(isLoading: boolean, delayMs = 150) {
  const [state, setState] = useState({ isLoading, visible: false });

  if (state.isLoading !== isLoading) {
    setState({ isLoading, visible: false });
  }

  useEffect(() => {
    if (!isLoading) return;
    const timer = window.setTimeout(() => setState({ isLoading: true, visible: true }), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, isLoading]);

  return isLoading && state.isLoading && state.visible;
}
