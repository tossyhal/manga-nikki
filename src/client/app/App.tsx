import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useBlocker, useLocation, type BlockerFunction } from 'react-router';
import type { DiaryActivity } from '../features/diary/diaryActivity';
import { getClientConfig, type ClientConfig } from '../lib/config';
import type { AppContext } from './AppContext';
import { BottomNav } from './BottomNav';
import { ConfirmDialog } from './ConfirmDialog';
import { PwaNotice } from './PwaNotice';

function documentTitle(pathname: string) {
  if (pathname === '/new') return '日記を書く | 漫画日記';
  if (pathname === '/library') return '記録 | 漫画日記';
  if (pathname.startsWith('/entries/')) return '記録の詳細 | 漫画日記';
  if (pathname === '/') return 'ホーム | 漫画日記';
  return 'ページが見つかりません | 漫画日記';
}

export function App() {
  const location = useLocation();
  const isPrimaryRoute = ['/', '/new', '/library'].includes(location.pathname);
  const mainRef = useRef<HTMLElement | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [configRetry, setConfigRetry] = useState(0);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({ dirty: false, busy: false });
  const diaryActivityRef = useRef(diaryActivity);
  const reportDiaryActivity = useCallback((activity: DiaryActivity) => {
    diaryActivityRef.current = activity;
    setDiaryActivity(activity);
  }, []);
  const retryConfig = useCallback(() => {
    setConfig(null);
    setConfigError(false);
    setConfigRetry((retry) => retry + 1);
  }, []);
  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      const leavingPage =
        currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search;
      const { dirty, busy } = diaryActivityRef.current;
      return leavingPage && (dirty || busy);
    },
    [],
  );
  const blocker = useBlocker(shouldBlockNavigation);
  const blockedActivity = blocker.state === 'blocked' ? diaryActivity : null;
  useEffect(() => {
    let active = true;
    void getClientConfig()
      .then((loadedConfig) => {
        if (active) setConfig(loadedConfig);
      })
      .catch(() => {
        if (active) setConfigError(true);
      });
    return () => {
      active = false;
    };
  }, [configRetry]);
  useLayoutEffect(() => {
    document.title = documentTitle(location.pathname);
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);
  useEffect(() => {
    if (blocker.state !== 'blocked' || diaryActivity.dirty || diaryActivity.busy) return;
    blocker.proceed();
  }, [blocker, diaryActivity.busy, diaryActivity.dirty]);
  useLayoutEffect(() => {
    if (!diaryActivity.dirty && !diaryActivity.busy) return;
    const preventUnloading = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnloading);
    return () => window.removeEventListener('beforeunload', preventUnloading);
  }, [diaryActivity.dirty, diaryActivity.busy]);
  const personalDataAvailable = config !== null && config.dataMode !== 'sample';
  const context: AppContext = {
    config,
    configError,
    personalDataAvailable,
    onActivityChange: reportDiaryActivity,
    retryConfig,
  };
  return (
    <div className={`app-shell${isPrimaryRoute ? ' primary-shell' : ''}`}>
      <a className="skip" href="#main">
        本文へ移動
      </a>
      <div className="app-notices">
        <PwaNotice
          diaryDirty={diaryActivity.dirty}
          diaryBusy={diaryActivity.busy}
          hideOfflineNotice={location.pathname === '/new'}
        />
      </div>
      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={`app-main${isPrimaryRoute ? ' primary-content' : ''}${location.pathname === '/' ? ' app-main-home' : ''}`}
      >
        <Outlet context={context} />
      </main>
      <BottomNav />
      <ConfirmDialog
        open={blockedActivity !== null && blocker.state === 'blocked'}
        variant={blockedActivity !== null && !blockedActivity.busy ? 'navigation-exit' : 'default'}
        icon={blockedActivity?.busy ? 'alert' : null}
        title={blockedActivity?.busy ? '処理中です' : '入力内容が保存されていません'}
        description={
          blockedActivity?.busy
            ? '保存結果が確定する前に移動します。保存に失敗すると、未保存の変更をこの画面で確認できなくなることがあります。'
            : 'このまま画面を離れると、保存されていない変更が失われます。'
        }
        confirmLabel={blockedActivity?.busy ? '移動する' : '保存せずに離れる'}
        cancelLabel="入力に戻る"
        cancelPrimary
        destructive
        onConfirm={() => {
          if (blocker.state === 'blocked') blocker.proceed();
        }}
        onCancel={() => {
          if (blocker.state === 'blocked') blocker.reset();
        }}
      />
    </div>
  );
}
