import { useCallback, useEffect, useState } from 'react';

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const refreshOnlineStatus = useCallback(() => {
    const current = navigator.onLine;
    setOnline(current);
    return current;
  }, []);

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  return { online, refreshOnlineStatus };
}
