import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Entry } from '../../../shared/schemas';
import { getEntries } from '../../lib/api';

export function Library() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getEntries()
      .then((result) => {
        if (active) setEntries(result.items);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <p className="eyebrow">振り返り</p>
      <h1>保存した記録</h1>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : entries === null ? (
        <output>読み込んでいます…</output>
      ) : entries.length === 0 ? (
        <div className="empty">
          <h2>最初の一日を残しましょう。</h2>
          <p>下書きもここから読み返せます。</p>
          <Link className="button" to="/new">
            日記を書く
          </Link>
        </div>
      ) : (
        <ul className="entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link to={`/entries/${entry.id}`}>
                <time>{entry.diaryDate}</time>
                <span>{entry.latestGenerationId ? 'モック漫画あり' : '下書き'}</span>
                <p>{entry.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
