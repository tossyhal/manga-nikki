import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
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

let turnstileScript: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScript) return turnstileScript;

  turnstileScript = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.dataset.mangaNikkiTurnstile = 'true';
    script.addEventListener(
      'load',
      () => {
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error('TURNSTILE_UNAVAILABLE'));
      },
      { once: true },
    );
    script.addEventListener(
      'error',
      () => {
        script.remove();
        turnstileScript = null;
        reject(new Error('TURNSTILE_UNAVAILABLE'));
      },
      { once: true },
    );
    document.head.append(script);
  }).catch((error: unknown) => {
    turnstileScript = null;
    throw error;
  });

  return turnstileScript;
}

export function RegistrationCaptcha({
  siteKey,
  requestKey,
  onToken,
  onError,
}: {
  siteKey: string;
  requestKey: number;
  onToken: (token: string) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onToken, onError });

  useEffect(() => {
    callbacksRef.current = { onToken, onError };
  }, [onError, onToken]);

  useEffect(() => {
    let active = true;
    let widgetId: string | null = null;
    let turnstile: TurnstileApi | null = null;

    void loadTurnstile()
      .then((api) => {
        if (!active || !containerRef.current) return;
        turnstile = api;
        widgetId = api.render(containerRef.current, {
          sitekey: siteKey,
          execution: 'execute',
          appearance: 'execute',
          callback: (token) => {
            if (token) callbacksRef.current.onToken(token);
            else callbacksRef.current.onError();
          },
          'error-callback': () => callbacksRef.current.onError(),
          'expired-callback': () => callbacksRef.current.onError(),
        });
        api.execute(widgetId);
      })
      .catch(() => {
        if (active) callbacksRef.current.onError();
      });

    return () => {
      active = false;
      if (turnstile && widgetId) turnstile.remove(widgetId);
    };
  }, [requestKey, siteKey]);

  return <div ref={containerRef} aria-label="匿名登録用CAPTCHA" />;
}
