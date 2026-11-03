import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router';
import { pageComic, sampleDiary } from '../../shared/fixtures';
import type { Entry } from '../../shared/schemas';
import { Comic } from '../features/comic/Comic';
import { NewEntry } from '../features/diary/NewEntry';
import { EntryHistory } from '../features/library/EntryHistory';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';
import { getEntries } from '../lib/api';

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

function Home({ available }: { available: boolean | null }) {
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
      {available === true && <RecentRecords />}
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
export function App() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/v1/config')
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const config = await response.json();
        setAvailable(config.dataMode === 'mock' && config.generationAvailable === true);
      })
      .catch(() => setAvailable(false));
  }, []);
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
        {available
          ? '開発用モック / AI・クラウドへの送信なし / サーバー再起動で記録は消えます'
          : available === null
            ? '環境を確認しています…'
            : 'サンプル閲覧用 / 保存・生成はこの環境では利用できません'}
      </aside>
      <main id="main">
        <Routes>
          <Route path="/" element={<Home available={available} />} />
          <Route
            path="/new"
            element={
              available === null ? (
                <output>読み込んでいます…</output>
              ) : available ? (
                <NewEntry />
              ) : (
                <p>
                  保存機能は利用できません。<Link to="/">サンプルを見る</Link>
                </p>
              )
            }
          />
          <Route
            path="/library"
            element={
              available === null ? (
                <output>読み込んでいます…</output>
              ) : available ? (
                <Library />
              ) : (
                <p>記録の閲覧はローカルの開発環境で利用できます。</p>
              )
            }
          />
          <Route
            path="/entries/:id"
            element={
              available === null ? (
                <output>読み込んでいます…</output>
              ) : available ? (
                <Detail />
              ) : (
                <p>記録の閲覧はローカルの開発環境で利用できます。</p>
              )
            }
          />
          <Route
            path="*"
            element={
              <>
                <h1>ページが見つかりません。</h1>
                <Link to="/">ホームへ戻る</Link>
              </>
            }
          />
        </Routes>
      </main>
      <footer>漫画日記 / 開発プレビュー</footer>
    </>
  );
}
