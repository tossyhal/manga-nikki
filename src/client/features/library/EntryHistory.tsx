import { Link } from 'react-router';
import type { Entry } from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';

export function EntryHistory({
  entries,
  nextCursor = null,
  onLoadMore,
  busy = false,
}: {
  entries: Entry[];
  nextCursor?: string | null;
  onLoadMore?: () => void;
  busy?: boolean;
}) {
  return (
    <>
      <ul className="entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Link to={`/entries/${entry.id}`}>
              <time dateTime={entry.diaryDate}>{entry.diaryDate}</time>
              <span>{entry.latestGenerationId ? '漫画の記録' : '下書き'}</span>
              <strong>{summarizeDiary(entry.body)}</strong>
            </Link>
          </li>
        ))}
      </ul>
      {nextCursor && onLoadMore && (
        <button disabled={busy} onClick={() => void onLoadMore()}>
          {busy ? '読み込んでいます…' : 'もっと見る'}
        </button>
      )}
    </>
  );
}
