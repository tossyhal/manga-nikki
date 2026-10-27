import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { EntryDetail } from '../../../shared/schemas';
import { api, generate, getEntry } from '../../lib/api';
import { Comic } from '../comic/Comic';

function DetailContent({ id }: { id: string }) {
  const navigate = useNavigate();
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    getEntry(id)
      .then((result) => {
        if (active) setEntry(result);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  async function act(remove: boolean) {
    if (!entry) return;
    setBusy(true);
    setError('');
    try {
      if (remove) {
        await api(`/entries/${entry.id}`, { method: 'DELETE' });
        navigate('/library');
      } else {
        await generate(entry);
        setEntry(await getEntry(id));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link to="/library">← 記録の一覧</Link>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {entry ? (
        <>
          <p className="eyebrow">
            {entry.diaryDate} / {entry.latestGeneration ? 'モック漫画' : '下書き'}
          </p>
          <h1>{entry.latestGeneration ? entry.latestGeneration.comic.title : '今日の記録'}</h1>
          <output className="saved">開発サーバーへ仮保存しました。</output>
          {entry.latestGeneration && <Comic />}
          <section>
            <h2>元の日記</h2>
            <p className="diary">{entry.body}</p>
          </section>
          <div className="actions">
            {!entry.latestGeneration && (
              <button disabled={busy} onClick={() => void act(false)}>
                モック漫画を見る
              </button>
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm('この記録を削除しますか？')) void act(true);
              }}
            >
              記録を削除
            </button>
          </div>
        </>
      ) : (
        !error && <output>読み込んでいます…</output>
      )}
    </>
  );
}
export function Detail() {
  const { id = '' } = useParams();
  return <DetailContent key={id} id={id} />;
}
