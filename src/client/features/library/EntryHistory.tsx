import { Link } from 'react-router';
import type { Entry } from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';
import { Icon } from '../../app/Icon';
import './library.css';

type EntryHistoryProps = {
  entries: Entry[];
  nextCursor?: string | null;
  onLoadMore?: () => void;
  busy?: boolean;
  monthHeadings?: boolean;
  compact?: boolean;
  showDate?: boolean;
};

function formatMonth(date: string) {
  const [year = '', month = ''] = date.split('-');
  return `${year}年${Number(month)}月`;
}

function formatDate(date: string) {
  const [, month = '', day = ''] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export function EntryHistory({
  entries,
  nextCursor = null,
  onLoadMore,
  busy = false,
  monthHeadings = false,
  compact = false,
  showDate = true,
}: EntryHistoryProps) {
  const groups = entries.reduce<Array<{ month: string; items: Entry[] }>>((result, entry) => {
    const month = entry.diaryDate.slice(0, 7);
    const last = result.at(-1);
    if (last?.month === month) last.items.push(entry);
    else result.push({ month, items: [entry] });
    return result;
  }, []);

  return (
    <div className="entry-history">
      {groups.map(({ month, items }) => {
        const firstEntry = items.at(0);
        return (
          <section className="entry-history-group" key={month}>
            {monthHeadings && firstEntry && (
              <h2 className="entry-history-month">{formatMonth(firstEntry.diaryDate)}</h2>
            )}
            <ul className={`entry-history-list${compact ? ' entry-history-list--compact' : ''}`}>
              {items.map((entry) => (
                <li className="entry-history-item" key={entry.id}>
                  <Link className="entry-history-card" to={`/entries/${entry.id}`}>
                    <span className="entry-history-art" aria-hidden="true">
                      <Icon name="book" size={compact ? 24 : 30} />
                    </span>
                    <span className="entry-history-copy">
                      <strong className="entry-history-summary">
                        {summarizeDiary(entry.body)}
                      </strong>
                      <span className="entry-history-meta">
                        {showDate && (
                          <time dateTime={entry.diaryDate}>{formatDate(entry.diaryDate)}</time>
                        )}
                        <span>{entry.latestGenerationId ? '生成履歴あり' : '下書き'}</span>
                      </span>
                    </span>
                    <Icon name="chevron-right" size={20} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {nextCursor && onLoadMore && (
        <button
          type="button"
          className="entry-history-load-more"
          disabled={busy}
          onClick={onLoadMore}
        >
          {busy ? '読み込んでいます…' : '続きを読み込む'}
        </button>
      )}
    </div>
  );
}
