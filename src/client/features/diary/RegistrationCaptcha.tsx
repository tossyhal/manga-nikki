import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      execution: 'execute';
      appearance: 'execute';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: { promise: Promise<TurnstileApi>; cancel: () => void } | null = null;
const turnstileScriptTimeout = 15_000;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScript) return turnstileScript.promise;

  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.dataset.mangaNikkiTurnstile = 'true';
  let settled = false;
  let timeoutId: number | null = null;
  let resolveLoad!: (api: TurnstileApi) => void;
  let rejectLoad!: (reason: Error) => void;
  const promise = new Promise<TurnstileApi>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  const load = {
    promise,
    cancel: () => failLoad('TURNSTILE_CANCELLED'),
  };
  const cleanup = (removeScript: boolean) => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    script.removeEventListener('load', handleLoad);
    script.removeEventListener('error', handleError);
    if (removeScript) script.remove();
    if (turnstileScript === load) turnstileScript = null;
  };
  const failLoad = (reason: string) => {
    if (settled) return;
    settled = true;
    cleanup(true);
    rejectLoad(new Error(reason));
  };
  const handleLoad = () => {
    if (!window.turnstile) {
      failLoad('TURNSTILE_UNAVAILABLE');
      return;
    }
    if (settled) return;
    settled = true;
    cleanup(false);
    resolveLoad(window.turnstile);
  };
  const handleError = () => failLoad('TURNSTILE_UNAVAILABLE');

  turnstileScript = load;
  script.addEventListener('load', handleLoad);
  script.addEventListener('error', handleError);
  timeoutId = window.setTimeout(() => failLoad('TURNSTILE_UNAVAILABLE'), turnstileScriptTimeout);
  document.head.append(script);
  return promise;
}

export function RegistrationCaptcha({
  siteKey,
  requestKey,
  action,
  label,
  onToken,
  onError,
}: {
  siteKey: string;
  requestKey: number;
  action?: 'generate';
  label?: string;
  onToken: (token: string) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ requestKey, onToken, onError });

  useEffect(() => {
    callbacksRef.current = { requestKey, onToken, onError };
  }, [onError, onToken, requestKey]);

  useEffect(() => {
    let active = true;
    let widgetId: string | null = null;
    let turnstile: TurnstileApi | null = null;

    void loadTurnstile()
      .then((api) => {
        if (!active || !containerRef.current) return;
        turnstile = api;
        const isCurrent = () => active && callbacksRef.current.requestKey === requestKey;
        widgetId = api.render(containerRef.current, {
          sitekey: siteKey,
          ...(action ? { action } : {}),
          execution: 'execute',
          appearance: 'execute',
          callback: (token) => {
            if (!isCurrent()) return;
            if (token) callbacksRef.current.onToken(token);
            else callbacksRef.current.onError();
          },
          'error-callback': () => {
            if (isCurrent()) callbacksRef.current.onError();
          },
          'expired-callback': () => {
            if (isCurrent()) callbacksRef.current.onError();
          },
        });
        api.execute(widgetId);
      })
      .catch(() => {
        if (active && callbacksRef.current.requestKey === requestKey)
          callbacksRef.current.onError();
      });

    return () => {
      active = false;
      if (turnstile && widgetId) turnstile.remove(widgetId);
      else if (!window.turnstile) turnstileScript?.cancel();
    };
  }, [action, requestKey, siteKey]);

  return <div ref={containerRef} aria-label={label ?? '匿名登録用CAPTCHA'} />;
}
