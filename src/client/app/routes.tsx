import { Link, useLocation, useOutletContext, type RouteObject } from 'react-router';
import { App } from './App';
import type { AppContext } from './AppContext';
import { AppStateCard, configUnavailableMessage } from './AppStateCard';
import { Home } from '../features/home/Home';
import { NewEntry } from '../features/diary/NewEntry';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';

function HomeRoute() {
  const { config, configError, retryConfig } = useOutletContext<AppContext>();
  return <Home config={config} configError={configError} retryConfig={retryConfig} />;
}
function NewEntryRoute() {
  const location = useLocation();
  const {
    config,
    configError,
    personalDataAvailable,
    onActivityChange,
    hasBlockedNavigation,
    hasConfirmedExit,
    retryConfig,
  } = useOutletContext<AppContext>();
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
    return (
      <NewEntry
        key={`${location.pathname}${location.search}`}
        config={config}
        onActivityChange={onActivityChange}
        hasBlockedNavigation={hasBlockedNavigation}
        hasConfirmedExit={hasConfirmedExit}
      />
    );
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
  const {
    config,
    configError,
    personalDataAvailable,
    onActivityChange,
    hasBlockedNavigation,
    retryConfig,
  } = useOutletContext<AppContext>();
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
    <Detail
      config={config}
      onActivityChange={onActivityChange}
      hasBlockedNavigation={hasBlockedNavigation}
    />
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

function NotFound() {
  return (
    <>
      <h1>ページが見つかりません。</h1>
      <Link to="/">ホームへ戻る</Link>
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
