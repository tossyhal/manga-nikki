import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Outlet, useBlocker, useLocation, type BlockerFunction } from 'react-router';
import type { DiaryActivity } from '../features/diary/diaryActivity';
import { getClientConfig, type ClientConfig } from '../lib/config';
import type { AppContext } from './AppContext';
import { BottomNav } from './BottomNav';
import { ConfirmDialog } from './ConfirmDialog';
import { PwaNotice } from './PwaNotice';
import { StartupScreen } from './StartupScreen';

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
  const [initialConfigPending, setInitialConfigPending] = useState(true);
  const [configRetry, setConfigRetry] = useState(0);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({
    dirty: false,
    busy: false,
    failed: false,
  });
  const [generationNotice, setGenerationNotice] =
    useState<DiaryActivity['generationNavigation']>(undefined);
  const diaryActivityRef = useRef(diaryActivity);
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
  const blockedBusy = Boolean(
    blockedActivity?.busy && !(blockedActivity.dirty && blockedActivity.entrySaveStarted === false),
  );
  const blockerStateRef = useRef(blocker.state);
  const leaveConfirmedRef = useRef(false);
  const reportDiaryActivity = useCallback((activity: DiaryActivity) => {
    diaryActivityRef.current = activity;
    setDiaryActivity(activity);
    if (
      !activity.dirty &&
      !activity.busy &&
      !activity.failed &&
      activity.generationNavigation &&
      blockerStateRef.current !== 'unblocked'
    )
      setGenerationNotice(activity.generationNavigation);
  }, []);
  const hasBlockedNavigation = useCallback(() => blockerStateRef.current !== 'unblocked', []);
  const hasConfirmedExit = useCallback(() => leaveConfirmedRef.current, []);
  useEffect(() => {
    let active = true;
    void getClientConfig()
      .then((loadedConfig) => {
        if (active) {
          setConfig(loadedConfig);
          setInitialConfigPending(false);
        }
      })
      .catch(() => {
        if (active) {
          setConfigError(true);
          setInitialConfigPending(false);
        }
      });
    return () => {
      active = false;
    };
  }, [configRetry]);
  useLayoutEffect(() => {
    document.title = documentTitle(location.pathname);
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);
  useLayoutEffect(() => {
    blockerStateRef.current = blocker.state;
    if (blocker.state === 'unblocked') leaveConfirmedRef.current = false;
  }, [blocker.state]);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (diaryActivity.failed) {
      if (!diaryActivity.dirty) blocker.reset();
      return;
    }
    if (diaryActivity.dirty || diaryActivity.busy) return;
    blocker.proceed();
  }, [blocker, diaryActivity.busy, diaryActivity.dirty, diaryActivity.failed]);
  if (
    generationNotice?.entryId &&
    blocker.state === 'unblocked' &&
    location.pathname === `/entries/${generationNotice.entryId}`
  )
    setGenerationNotice(undefined);
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
    hasBlockedNavigation,
    hasConfirmedExit,
    retryConfig,
  };
  const showBlockedDialog =
    blocker.state === 'blocked' && (!diaryActivity.failed || diaryActivity.dirty);
  return (
    <div className={`app-shell${isPrimaryRoute ? ' primary-shell' : ''}`}>
      <a className="skip" href="#main">
        本文へ移動
      </a>
      <div className="app-notices">
        {generationNotice && (
          <output className="pwa-notice" aria-live="polite">
            <p>
              {generationNotice.stage === 'accepted'
                ? '日記を保存し、漫画を受け付けました。生成状況は保存した記録で確認できます。'
                : generationNotice.stage === 'unrequested'
                  ? '日記を保存しました。漫画はまだ受け付けていません。保存した記録から受付を続けられます。'
                  : generationNotice.stage === 'requesting'
                    ? '漫画の受付結果が未確定です。保存した記録で最新の状態を確認してください。'
                    : '日記の保存結果が未確定です。漫画はまだ受け付けていません。記録で保存結果を確認してください。'}
            </p>
            <div className="pwa-notice-actions">
              <Link
                className="button button-secondary"
                to={generationNotice.entryId ? `/entries/${generationNotice.entryId}` : '/library'}
                state={generationNotice.stage === 'unrequested' ? { startGeneration: true } : null}
              >
                {generationNotice.stage === 'unrequested' ? '漫画の受付を続ける' : '記録で確認する'}
              </Link>
              <button
                className="button-text"
                type="button"
                onClick={() => setGenerationNotice(undefined)}
              >
                閉じる
              </button>
            </div>
          </output>
        )}
        <PwaNotice
          diaryDirty={diaryActivity.dirty}
          diaryBusy={diaryActivity.busy}
          hideOfflineNotice={location.pathname === '/new' && !initialConfigPending}
        />
      </div>
      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={`app-main${isPrimaryRoute ? ' primary-content' : ''}${location.pathname === '/' ? ' app-main-home' : ''}${initialConfigPending ? ' app-main-startup' : ''}`}
      >
        {initialConfigPending ? <StartupScreen /> : <Outlet context={context} />}
      </main>
      {!initialConfigPending && <BottomNav />}
      <ConfirmDialog
        open={showBlockedDialog}
        variant={blockedActivity !== null && !blockedBusy ? 'navigation-exit' : 'default'}
        icon={blockedBusy ? 'alert' : null}
        title={blockedBusy ? '処理中です' : '入力内容が保存されていません'}
        description={
          blockedBusy
            ? '保存結果が確定する前に移動します。保存に失敗すると、未保存の変更をこの画面で確認できなくなることがあります。'
            : 'このまま画面を離れると、保存されていない変更が失われます。'
        }
        confirmLabel={blockedBusy ? '移動する' : '保存せずに離れる'}
        cancelLabel="入力に戻る"
        cancelPrimary
        destructive
        onConfirm={() => {
          if (
            blocker.state === 'blocked' &&
            !(diaryActivityRef.current.failed && !diaryActivityRef.current.dirty)
          ) {
            if (
              diaryActivityRef.current.generationNavigation &&
              (diaryActivityRef.current.generationNavigation.stage !== 'saving' ||
                diaryActivityRef.current.entrySaveStarted)
            )
              setGenerationNotice(diaryActivityRef.current.generationNavigation);
            if (!blockedBusy) leaveConfirmedRef.current = true;
            blocker.proceed();
          }
        }}
        onCancel={() => {
          if (blocker.state === 'blocked') {
            leaveConfirmedRef.current = false;
            blocker.reset();
          }
        }}
      />
    </div>
  );
}
