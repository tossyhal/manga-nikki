import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useBlocker,
  useOutletContext,
  type BlockerFunction,
  type RouteObject,
} from 'react-router';
import { pageComic, sampleDiary } from '../../shared/fixtures';
import type { Entry } from '../../shared/schemas';
import { Comic } from '../features/comic/Comic';
import { NewEntry, type DiaryActivity } from '../features/diary/NewEntry';
import { EntryHistory } from '../features/library/EntryHistory';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';
import { getEntries } from '../lib/api';
import { getClientConfig, type ClientConfig } from '../lib/config';
import { PwaNotice } from './PwaNotice';

const configUnavailableMessage = '現在、読み込めません。通信を確認して再読み込みしてください。';

type AppContext = {
  config: ClientConfig | null;
  configError: boolean;
  personalDataAvailable: boolean;
  onActivityChange: (activity: DiaryActivity) => void;
};

function RecentRecords() {
  const [recent, setRecent] = useState<Entry[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    let active = true;
    getEntries({ limit: 5 })
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
  }, []);
  return (
    <section>
      <h2>過去の記録</h2>
      {historyError && (
        <p role="alert" className="error">
          {historyError}
        </p>
      )}
      {recent === null ? (
        <output>読み込んでいます…</output>
      ) : recent.length === 0 ? (
        <p>まだ保存した日記はありません。書いた記録は、要約を見出しにしてここに並びます。</p>
      ) : (
        <>
          <EntryHistory entries={recent} />
          <p>
            <Link to="/library">すべての記録を見る →</Link>
          </p>
        </>
      )}
    </section>
  );
}

function Home({ config }: { config: ClientConfig | null }) {
  return (
    <>
      <p className="eyebrow">一日を、4つの場面に。</p>
      <h1>
        今日のことを、
        <br />
        また読みたくなる形に。
      </h1>
      <p>
        短い日記を書いて、漫画で振り返る。まずは架空のサンプルで、使い心地を確かめてみてください。
      </p>
      <div className="actions">
        <Link className="button" to="/new">
          日記を書く
        </Link>
        <Link to="/library">保存した記録を見る →</Link>
      </div>
      {config?.dataMode === 'mock' && <RecentRecords />}
      <section className="sample">
        <h2>サンプルの一日</h2>
        <p>{sampleDiary}</p>
        <Comic
          comic={pageComic}
          images={{
            [pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '']: '/sample-comic.svg',
          }}
          mock
          titleAs="h3"
        />
      </section>
    </>
  );
}

function HomeRoute() {
  const { config } = useOutletContext<AppContext>();
  return <Home config={config} />;
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
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({ dirty: false, busy: false });
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
    if (blocker.state !== 'blocked') return;
    const { dirty, busy } = diaryActivityRef.current;
    const message = busy
      ? '保存などの処理中です。この画面を離れると結果を確認できなくなることがあります。移動しますか？'
      : dirty
        ? '未保存の入力があります。画面を離れると入力内容が失われます。移動しますか？'
        : 'この画面を離れますか？';
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
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
    <>
      <a className="skip" href="#main">
        本文へ移動
      </a>
      <header>
        <Link className="brand" to="/">
          漫画日記<span>小さな一日を、残す。</span>
        </Link>
        <nav aria-label="メインナビゲーション">
          <NavLink to="/new">日記を書く</NavLink>
          <NavLink to="/library">記録</NavLink>
        </nav>
      </header>
      <aside className="notice">
        {config?.dataMode === 'mock'
          ? '記録は一時的に保存され、予告なく消える場合があります。AIには送信されません。'
          : config?.dataMode === 'live'
            ? '記録を保存する前に利用条件をご確認ください。'
            : config?.dataMode === 'sample'
              ? 'サンプルを表示しています。保存・生成は利用できません。'
              : configError
                ? configUnavailableMessage
                : '利用できる機能を確認しています…'}
      </aside>
      <PwaNotice diaryDirty={diaryActivity.dirty} diaryBusy={diaryActivity.busy} />
      <main id="main">
        <Outlet context={context} />
      </main>
      <footer>漫画日記</footer>
    </>
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
