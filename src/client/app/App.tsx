import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router';
import { pageComic, sampleDiary } from '../../shared/fixtures';
import { Comic } from '../features/comic/Comic';
import { NewEntry, type DiaryActivity } from '../features/diary/NewEntry';
import { Library } from '../features/library/Library';
import { Detail } from '../features/library/Detail';
import { PwaNotice } from './PwaNotice';

function Home() {
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
      <section className="sample">
        <h2>サンプルの一日</h2>
        <p>{sampleDiary}</p>
        <Comic
          comic={pageComic}
          images={{
            [pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '']: '/sample-comic.svg',
          }}
          mock
        />
      </section>
    </>
  );
}
export function App() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [diaryActivity, setDiaryActivity] = useState<DiaryActivity>({ dirty: false, busy: false });
  const reportDiaryActivity = useCallback(
    (activity: DiaryActivity) => setDiaryActivity(activity),
    [],
  );
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
      <PwaNotice diaryDirty={diaryActivity.dirty} diaryBusy={diaryActivity.busy} />
      <main id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/new"
            element={
              available === null ? (
                <output>読み込んでいます…</output>
              ) : available ? (
                <NewEntry onActivityChange={reportDiaryActivity} />
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
