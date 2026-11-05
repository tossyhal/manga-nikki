import { useEffect, useState } from 'react';
import { jstToday } from '../../shared/date';

export function useJstToday() {
  const [today, setToday] = useState(jstToday);

  useEffect(() => {
    let timer = 0;

    function updateToday() {
      const currentDay = jstToday();
      setToday((previousDay) => (previousDay === currentDay ? previousDay : currentDay));

      window.clearTimeout(timer);
      const nextMidnight = Date.parse(`${currentDay}T15:00:00.000Z`);
      timer = window.setTimeout(updateToday, Math.max(1, nextMidnight - Date.now() + 1));
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') updateToday();
    }

    updateToday();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', updateToday);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', updateToday);
    };
  }, []);

  return today;
}
