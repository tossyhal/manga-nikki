import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Link,
  Outlet,
  useBlocker,
  useLocation,
  useOutletContext,
  type BlockerFunction,
  type RouteObject,
} from 'react-router';
import { jstToday, type Entry } from '../../shared/schemas';
import { pageComic, sampleDiary } from '../../shared/fixtures';
import catSleeping from '../../../design/assets/cat_sleeping.svg?url';
import { Comic } from '../features/comic/Comic';
import { NewEntry, type DiaryActivity } from '../features/diary/NewEntry';
import { EntryHistory } from '../features/library/EntryHistory';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';
import { getEntries } from '../lib/api';
import { getClientConfig, type ClientConfig } from '../lib/config';
import { BottomNav } from './BottomNav';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { PwaNotice } from './PwaNotice';

const configUnavailableMessage = '現在、読み込めません。通信を確認して再読み込みしてください。';

type AppContext = {
  config: ClientConfig | null;
  configError: boolean;
  personalDataAvailable: boolean;
  onActivityChange: (activity: DiaryActivity) => void;
};

function RecentRecords({ entries }: { entries: Entry[] }) {
  return (
    <section className="recent-records">
      <div className="section-heading-row">
        <h2>最近の記録</h2>
        <Link className="icon-link" to="/library" aria-label="すべての記録を見る">
          <Icon name="chevron-right" />
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="muted-copy">書いた記録がここに並びます。</p>
      ) : (
        <EntryHistory entries={entries.slice(0, 2)} />
      )}
    </section>
  );
}

function Home({
  config,
  configError,
}: {
  config: ClientConfig | null;
  configError: boolean;
}) {
  const isMock = config?.dataMode === 'mock';
  const showSample = config?.dataMode === 'sample' || config?.dataMode === 'live';
  const { recent, historyError } = useRecentRecordsForHome(isMock);
  const todayEntries = recent?.filter((entry) => entry.diaryDate === jstToday()) ?? [];
  const [sampleOpen, setSampleOpen] = useState(false);
  const now = new Date();
  const today = `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
  }).format(now)} ${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    weekday: 'long',
  }).format(now)}`;

  if (showSample && sampleOpen) {
    return (
      <section className="sample-detail" aria-labelledby="sample-detail-title">
        <div className="detail-toolbar">
          <button className="icon-button" type="button" onClick={() => setSampleOpen(false)}>
            <Icon name="back" />
            <span className="sr-only">戻る</span>
          </button>
          <span className="sample-tag">架空サンプル</span>
          <span aria-hidden="true" className="toolbar-spacer" />
        </div>
        <h1 id="sample-detail-title" className="detail-title">
          {pageComic.title}
        </h1>
        <Comic
          comic={pageComic}
          images={{
            [pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '']:
              '/sample-comic.svg',
          }}
          mock
          titleAs="h2"
        />
        <details className="original-diary" open>
          <summary>元の日記</summary>
          <p>{sampleDiary}</p>
        </details>
      </section>
    );
  }

  return (
    <div className="home-page">
      {isMock && (
        <time className="home-date" dateTime={jstToday()}>
          {today}
        </time>
      )}
      {configError && (
        <div className="today-unavailable-card" role="alert">
          <Icon name="alert" size={24} />
          <p>{configUnavailableMessage}</p>
        </div>
      )}
      <section className="today-section" aria-labelledby="today-heading">
        <h1 id="today-heading">今日の記録</h1>
        {configError ? null : config === null ? (
          <output className="today-card-loading">読み込んでいます…</output>
        ) : showSample ? (
          <div className="today-sample-card">
            <img src="/sample-comic.svg" alt="架空の一日の4コマ漫画" loading="lazy" />
            <div className="today-sample-copy">
              <span className="sample-tag">架空サンプル</span>
              <h2>{pageComic.title}</h2>
              <p>日記を漫画にしたサンプルです。</p>
              <button className="today-write-link" type="button" onClick={() => setSampleOpen(true)}>
                <span>漫画を読む</span>
                <Icon name="chevron-right" size={18} />
              </button>
            </div>
          </div>
        ) : isMock && recent === null ? (
          <output className="today-card-loading">読み込んでいます…</output>
        ) : isMock && historyError ? (
          <div className="today-unavailable-card" role="alert">
            <Icon name="alert" size={24} />
            <p>今日の記録を読み込めませんでした。</p>
            <span>{historyError}</span>
          </div>
        ) : todayEntries.length > 0 ? (
          <div className="today-records">
            <EntryHistory entries={todayEntries} />
          </div>
        ) : (
          <div className="today-empty-card">
            <p>今日はまだ記録がありません</p>
            <img src={catSleeping} alt="丸くなって眠る猫" width="148" height="100" />
            <Link className="today-write-link" to="/new">
              <Icon name="plus" size={20} />
              <span>日記を書く</span>
            </Link>
          </div>
        )}
      </section>

      {isMock && recent !== null && !historyError && <RecentRecords entries={recent} />}

    </div>
  );
}

function useRecentRecordsForHome(enabled: boolean) {
  const [recent, setRecent] = useState<Entry[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getEntries({ limit: 20 })
      .then((result) => {
        if (active) setRecent(result.items);
      })
      .catch((failure: Error) => {
        if (active) {
          setRecent([]);
          setHistoryError(failure.message);
        }
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return { recent, historyError };
}

function HomeRoute() {
  const { config, configError } = useOutletContext<AppContext>();
  return <Home config={config} configError={configError} />;
}
function NewEntryRoute() {
  const { config, configError, personalDataAvailable, onActivityChange } =
    useOutletContext<AppContext>();
  if (!config && !configError) return <output>読み込んでいます…</output>;
  if (configError) return <p role="alert">{configUnavailableMessage}</p>;
  if (personalDataAvailable && config)
    return <NewEntry config={config} onActivityChange={onActivityChange} />;
  return (
    <p>
      保存機能は利用できません。<Link to="/">サンプルを見る</Link>
    </p>
  );
}

function LibraryRoute() {
  const { config, configError, personalDataAvailable } = useOutletContext<AppContext>();
  if (!config && !configError) return <output>読み込んでいます…</output>;
  if (configError) return <p role="alert">{configUnavailableMessage}</p>;
  return personalDataAvailable ? (
    <Library />
  ) : (
    <p>記録の閲覧はこのサンプル環境では利用できません。</p>
  );
}

function DetailRoute() {
  const { config, configError, personalDataAvailable, onActivityChange } =
    useOutletContext<AppContext>();
  if (!config && !configError) return <output>読み込んでいます…</output>;
  if (configError) return <p role="alert">{configUnavailableMessage}</p>;
  return personalDataAvailable && config ? (
    <Detail config={config} onActivityChange={onActivityChange} />
  ) : (
    <p>記録の閲覧はこのサンプル環境では利用できません。</p>
  );
}

function NotFound() {
  return (
    <>
      <h1>ページが見つかりません。</h1>
      <Link to="/">ホームへ戻る</Link>
    </>
  );
}

function App() {
  const location = useLocation();
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({ dirty: false, busy: false });
  const [blockedActivity, setBlockedActivity] = useState<DiaryActivity | null>(null);
  const diaryActivityRef = useRef(diaryActivity);
  const reportDiaryActivity = useCallback((activity: DiaryActivity) => {
    diaryActivityRef.current = activity;
    setDiaryActivity(activity);
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
  useEffect(() => {
    void getClientConfig()
      .then(setConfig)
      .catch(() => setConfigError(true));
  }, []);
  useEffect(() => {
    if (blocker.state === 'blocked') setBlockedActivity(diaryActivityRef.current);
    else setBlockedActivity(null);
  }, [blocker.state]);
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
  };
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        本文へ移動
      </a>
      {location.pathname === '/' && (
        <header className="app-header">
          <Link className="brand" to="/" aria-label="漫画日記 ホーム">
            まんが日記
          </Link>
          <span className="header-settings" aria-hidden="true">
            <Icon name="settings" />
          </span>
        </header>
      )}
      {configError && (
        <aside className="notice" role="alert">
          {configUnavailableMessage}
        </aside>
      )}
      <PwaNotice diaryDirty={diaryActivity.dirty} diaryBusy={diaryActivity.busy} />
      <main id="main" className="app-main">
        <Outlet context={context} />
      </main>
      <BottomNav />
      <ConfirmDialog
        open={blockedActivity !== null && blocker.state === 'blocked'}
        icon="alert"
        title={blockedActivity?.busy ? '処理中です' : '入力内容が保存されていません'}
        description={
          blockedActivity?.busy
            ? '保存などの処理中です。この画面を離れると結果を確認できなくなることがあります。'
            : 'このまま画面を離れますか？'
        }
        confirmLabel={blockedActivity?.busy ? '移動する' : '保存せずに離れる'}
        cancelLabel="入力に戻る"
        cancelPrimary
        destructive
        onConfirm={() => {
          setBlockedActivity(null);
          if (blocker.state === 'blocked') blocker.proceed();
        }}
        onCancel={() => {
          setBlockedActivity(null);
          if (blocker.state === 'blocked') blocker.reset();
        }}
      />
    </div>
  );
}

export const appRoute: RouteObject = {
  path: '/',
  element: <App />,
  children: [
    { index: true, element: <HomeRoute /> },
    { path: 'new', element: <NewEntryRoute /> },
    { path: 'library', element: <LibraryRoute /> },
    { path: 'entries/:id', element: <DetailRoute /> },
    { path: '*', element: <NotFound /> },
  ],
};
