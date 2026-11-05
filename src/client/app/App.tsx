import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Link,
  Outlet,
  useBlocker,
  useLocation,
  useOutletContext,
  type BlockerFunction,
  type RouteObject,
} from 'react-router';
import { jstToday, type Entry, type Generation } from '../../shared/schemas';
import { pageComic, sampleDiary } from '../../shared/fixtures';
import { summarizeDiary } from '../../shared/summary';
import catSleeping from '../../../design/assets/cat_sleeping.svg?url';
import { Comic } from '../features/comic/Comic';
import { NewEntry, type DiaryActivity } from '../features/diary/NewEntry';
import { EntryHistory } from '../features/library/EntryHistory';
import { EntryThumbnail, useEntryPreview } from '../features/library/EntryPreview';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';
import { getEntries } from '../lib/api';
import { getLiveAccessToken } from '../lib/auth';
import { getClientConfig, type ClientConfig } from '../lib/config';
import { useOnlineStatus } from '../lib/useOnlineStatus';
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
  retryConfig: () => void;
};

type AppStateCardProps = {
  title: string;
  description: string;
  actions?: ReactNode;
  role?: 'alert';
  status?: boolean;
  headingLevel?: 'h1' | 'h2';
};

function AppStateCard({
  title,
  description,
  actions,
  role,
  status = false,
  headingLevel = 'h1',
}: AppStateCardProps) {
  const Heading = headingLevel;
  return (
    <section
      className="app-state-card"
      role={role}
      aria-labelledby="app-state-title"
      aria-live={status ? 'polite' : undefined}
      aria-atomic={status ? true : undefined}
    >
      <Icon name={role === 'alert' ? 'alert' : status ? 'clock' : 'book'} size={40} />
      <Heading id="app-state-title">{title}</Heading>
      <p>{description}</p>
      {actions && <div className="app-state-actions">{actions}</div>}
    </section>
  );
}

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
        <EntryHistory entries={entries.slice(0, 2)} showStatus />
      )}
    </section>
  );
}

function generationLabel(
  generation: Generation | null,
  entry: Entry,
  loading: boolean,
  error?: string,
) {
  if (error)
    return error.includes('画像') ? '漫画画像を読み込めません' : '記録の状態を確認できません';
  if (!generation || generation.entryRevision !== entry.revision) {
    if (entry.latestGenerationId)
      return loading ? '状態を確認しています' : '記録を開いて状態を確認';
    return '下書き';
  }
  switch (generation.status) {
    case 'queued':
    case 'running':
      return '漫画を作成中';
    case 'unknown':
      return '生成結果を確認中';
    case 'failed':
      return '漫画を生成できませんでした';
    case 'cancelled':
      return '生成を終了しました';
    case 'succeeded':
      return '完成';
    default:
      return '状態を確認しています';
  }
}

function TodayEntryHero({ entry }: { entry: Entry }) {
  const preview = useEntryPreview(entry, { eager: true });
  const generation =
    preview.generation?.entryRevision === entry.revision ? preview.generation : null;
  let placeholder = '漫画はまだありません';
  if (preview.isLoading) placeholder = '漫画を読み込んでいます';
  else if (preview.error?.includes('画像')) placeholder = '漫画を表示できません';
  else if (preview.error) placeholder = '記録の状態を確認できません';
  else if (entry.latestGenerationId && !generation) placeholder = '記録を開いて状態を確認';
  else if (generation?.status === 'queued' || generation?.status === 'running')
    placeholder = '漫画を作成中';
  else if (generation?.status === 'failed' || generation?.status === 'cancelled')
    placeholder = '漫画はありません';
  const hasComic = generation?.status === 'succeeded';
  const comicTitle =
    generation?.status === 'succeeded' ? generation.comic.title : summarizeDiary(entry.body);

  return (
    <div className="home-today-hero">
      <div className="home-today-content">
        <h2>{summarizeDiary(entry.body)}</h2>
        <p>{generationLabel(generation, entry, preview.isLoading, preview.error)}</p>
        <Link className="today-write-link" to={`/entries/${encodeURIComponent(entry.id)}`}>
          <span>{hasComic ? '漫画を読む' : '記録を読む'}</span>
          <Icon name="chevron-right" size={18} />
        </Link>
      </div>
      <Link
        className="home-today-image"
        to={`/entries/${encodeURIComponent(entry.id)}`}
        aria-label={`${comicTitle}の記録を読む`}
      >
        <EntryThumbnail
          preview={preview}
          className="home-today-image-preview"
          iconSize={32}
          ariaHidden
          placeholderLabel={placeholder}
        />
      </Link>
    </div>
  );
}

function Home({
  config,
  configError,
  retryConfig,
}: {
  config: ClientConfig | null;
  configError: boolean;
  retryConfig: () => void;
}) {
  const [recordsRetry, setRecordsRetry] = useState(0);
  const records = useHomeRecords(config, configError, recordsRetry);
  const showSample = records.status === 'sample';
  const entries = records.status === 'ready' ? records.entries : [];
  const todayEntries = entries.filter((entry) => entry.diaryDate === jstToday());
  const todayEntry = todayEntries[0] ?? null;
  const recentEntries = entries.filter((entry) => entry.id !== todayEntry?.id).slice(0, 2);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [today] = useState(() => {
    const date = jstToday();
    const value = new Date(`${date}T00:00:00.000Z`);
    const monthDay = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
    }).format(value);
    const weekday = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(value);
    return { date, label: `${monthDay} ${weekday}` };
  });

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
            [pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '']: '/sample-comic.svg',
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
      {today && (
        <time className="home-date" dateTime={today.date}>
          {today.label}
        </time>
      )}
      <section className="today-section" aria-labelledby="today-heading">
        <h1 id="today-heading" className={showSample && !configError ? undefined : 'sr-only'}>
          {showSample && !configError ? 'サンプル' : '今日の記録'}
        </h1>
        {configError ? (
          <AppStateCard
            headingLevel="h2"
            title="読み込めませんでした"
            description={configUnavailableMessage}
            role="alert"
            actions={
              <>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setSampleOpen(true)}
                >
                  サンプルを見る
                </button>
                <button className="button button-secondary" type="button" onClick={retryConfig}>
                  再読み込み
                </button>
              </>
            }
          />
        ) : showSample ? (
          <div className="home-today-hero">
            <div className="home-today-content">
              <h2>{pageComic.title}</h2>
              <p>サンプル漫画</p>
              <div className="home-today-actions">
                <button
                  className="today-write-link"
                  type="button"
                  onClick={() => setSampleOpen(true)}
                >
                  <span>漫画を読む</span>
                  <Icon name="chevron-right" size={18} />
                </button>
                {config?.dataMode !== 'sample' && (
                  <Link className="today-create-link" to="/new">
                    <Icon name="plus" size={20} />
                    <span>日記を書く</span>
                  </Link>
                )}
              </div>
            </div>
            <div className="home-today-image">
              <img src="/sample-comic.svg" alt="架空の一日の4コマ漫画" loading="lazy" />
            </div>
          </div>
        ) : config === null ? (
          <AppStateCard
            headingLevel="h2"
            title="準備しています"
            description="記録を読み込んでいます。"
            status
          />
        ) : records.status === 'loading' ? (
          <AppStateCard
            headingLevel="h2"
            title="記録を読み込んでいます"
            description="少しお待ちください。"
            status
          />
        ) : records.status === 'error' ? (
          <AppStateCard
            headingLevel="h2"
            title="記録を読み込めませんでした"
            description={records.message}
            role="alert"
            actions={
              <>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setRecordsRetry((retry) => retry + 1)}
                >
                  再読み込み
                </button>
                <Link className="button button-secondary" to="/new">
                  日記を書く
                </Link>
              </>
            }
          />
        ) : todayEntry ? (
          <TodayEntryHero entry={todayEntry} />
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

      {records.status === 'ready' && <RecentRecords entries={recentEntries} />}
    </div>
  );
}

type HomeRecords =
  | { status: 'loading' }
  | { status: 'sample' }
  | { status: 'ready'; entries: Entry[] }
  | { status: 'error'; message: string };

function useHomeRecords(
  config: ClientConfig | null,
  configError: boolean,
  retryKey: number,
): HomeRecords {
  const { online } = useOnlineStatus();
  const [loaded, setLoaded] = useState<{
    config: ClientConfig | null;
    configError: boolean;
    retryKey: number;
    records: HomeRecords;
  }>({ config: null, configError: false, retryKey: -1, records: { status: 'loading' } });
  const records =
    configError || config?.dataMode === 'sample' || (config !== null && !online)
      ? { status: 'sample' as const }
      : !config
        ? { status: 'loading' as const }
        : loaded.config === config &&
            loaded.configError === configError &&
            loaded.retryKey === retryKey
          ? loaded.records
          : { status: 'loading' as const };

  useEffect(() => {
    if (configError || !config || config.dataMode === 'sample' || !online) return;
    const currentConfig = config;
    let active = true;
    async function loadEntries() {
      try {
        if (currentConfig.dataMode === 'live' && !(await getLiveAccessToken())) {
          if (active)
            setLoaded({
              config: currentConfig,
              configError,
              retryKey,
              records: { status: 'sample' },
            });
          return;
        }
        const result = await getEntries({ limit: 20 });
        if (active)
          setLoaded({
            config: currentConfig,
            configError,
            retryKey,
            records: { status: 'ready', entries: result.items },
          });
      } catch (failure) {
        if (active)
          setLoaded({
            config: currentConfig,
            configError,
            retryKey,
            records: !navigator.onLine
              ? { status: 'sample' }
              : {
                  status: 'error',
                  message: failure instanceof Error ? failure.message : '通信を確認してください。',
                },
          });
      }
    }
    void loadEntries();
    return () => {
      active = false;
    };
  }, [config, configError, online, retryKey]);
  return records;
}

function HomeRoute() {
  const { config, configError, retryConfig } = useOutletContext<AppContext>();
  return <Home config={config} configError={configError} retryConfig={retryConfig} />;
}
function NewEntryRoute() {
  const { config, configError, personalDataAvailable, onActivityChange, retryConfig } =
    useOutletContext<AppContext>();
  if (!config && !configError)
    return (
      <AppStateCard title="準備しています" description="入力画面を読み込んでいます。" status />
    );
  if (configError)
    return (
      <AppStateCard
        title="読み込めませんでした"
        description={configUnavailableMessage}
        role="alert"
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={retryConfig}>
              再読み込み
            </button>
            <Link className="button button-secondary" to="/">
              ホーム
            </Link>
          </>
        }
      />
    );
  if (personalDataAvailable && config)
    return <NewEntry config={config} onActivityChange={onActivityChange} />;
  return (
    <AppStateCard
      title="日記を保存できません"
      description="この環境では個人の記録を保存できません。ホームから架空サンプルを確認できます。"
      actions={
        <Link className="button button-secondary" to="/">
          サンプルを見る
        </Link>
      }
    />
  );
}

function LibraryRoute() {
  const { config, configError, personalDataAvailable, retryConfig } =
    useOutletContext<AppContext>();
  if (!config && !configError)
    return <AppStateCard title="準備しています" description="記録を読み込んでいます。" status />;
  if (configError)
    return (
      <AppStateCard
        title="読み込めませんでした"
        description={configUnavailableMessage}
        role="alert"
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={retryConfig}>
              再読み込み
            </button>
            <Link className="button button-secondary" to="/">
              ホーム
            </Link>
          </>
        }
      />
    );
  return personalDataAvailable ? (
    <Library />
  ) : (
    <AppStateCard
      title="個人の記録を表示できません"
      description="この環境では個人の記録を読み込みません。ホームから架空サンプルを確認できます。"
      actions={
        <Link className="button button-secondary" to="/">
          サンプルを見る
        </Link>
      }
    />
  );
}

function DetailRoute() {
  const { config, configError, personalDataAvailable, onActivityChange, retryConfig } =
    useOutletContext<AppContext>();
  if (!config && !configError)
    return <AppStateCard title="準備しています" description="記録を読み込んでいます。" status />;
  if (configError)
    return (
      <AppStateCard
        title="読み込めませんでした"
        description={configUnavailableMessage}
        role="alert"
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={retryConfig}>
              再読み込み
            </button>
            <Link className="button button-secondary" to="/">
              ホーム
            </Link>
          </>
        }
      />
    );
  return personalDataAvailable && config ? (
    <Detail config={config} onActivityChange={onActivityChange} />
  ) : (
    <AppStateCard
      title="記録を表示できません"
      description="この環境では個人の記録を読み込みません。ホームから架空サンプルを確認できます。"
      actions={
        <Link className="button button-secondary" to="/">
          サンプルを見る
        </Link>
      }
    />
  );
}

function documentTitle(pathname: string) {
  if (pathname === '/new') return '日記を書く | 漫画日記';
  if (pathname === '/library') return '記録 | 漫画日記';
  if (pathname.startsWith('/entries/')) return '記録の詳細 | 漫画日記';
  if (pathname === '/') return 'ホーム | 漫画日記';
  return 'ページが見つかりません | 漫画日記';
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
  const isPrimaryRoute = ['/', '/new', '/library'].includes(location.pathname);
  const mainRef = useRef<HTMLElement | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [configRetry, setConfigRetry] = useState(0);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({ dirty: false, busy: false });
  const [blockedActivity, setBlockedActivity] = useState<DiaryActivity | null>(null);
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
