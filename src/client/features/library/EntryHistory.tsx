import { Link } from 'react-router';
import type { Entry, Generation } from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';
import { Icon } from '../../app/Icon';
import { EntryThumbnail, useEntryPreview } from './EntryPreview';
import './library.css';

type EntryHistoryProps = {
  entries: Entry[];
  backTo?: string;
  nextCursor?: string | null;
  onLoadMore?: () => void;
  busy?: boolean;
  monthHeadings?: boolean;
  compact?: boolean;
  showDate?: boolean;
  showStatus?: boolean;
};

function formatMonth(date: string) {
  const [year = '', month = ''] = date.split('-');
  return `${year}年${Number(month)}月`;
}

function formatDate(date: string) {
  const [, month = '', day = ''] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function generationLabel(status: Generation['status']) {
  switch (status) {
    case 'queued':
      return '生成待ち';
    case 'running':
      return '生成中';
    case 'succeeded':
      return '4コマ漫画';
    case 'failed':
      return '生成失敗';
    case 'unknown':
      return '結果確認中';
    case 'cancelled':
      return '生成中止';
    default:
      return null;
  }
}

function EntryHistoryItem({
  entry,
  compact,
  showDate,
  showStatus,
  backTo,
}: {
  entry: Entry;
  compact: boolean;
  showDate: boolean;
  showStatus: boolean;
  backTo?: string;
}) {
  const preview = useEntryPreview(entry);
  const currentGeneration =
    preview.generation?.entryRevision === entry.revision ? preview.generation : null;
  const hasOlderLatest = Boolean(
    preview.generation && preview.generation.entryRevision < entry.revision,
  );
  const staleLabel = preview.comicGeneration ? '編集前の漫画' : '編集済み';
  const statusLabel = showStatus
    ? preview.isStale
      ? currentGeneration
        ? `${generationLabel(currentGeneration.status) ?? '状態未確認'}・編集前の漫画あり`
        : staleLabel
      : hasOlderLatest
        ? staleLabel
        : currentGeneration
          ? generationLabel(currentGeneration.status)
          : entry.latestGenerationId
            ? preview.error
              ? '状態を確認できません'
              : '状態を確認しています'
            : '下書き'
    : null;
  const previewError =
    preview.imageError ??
    (preview.error && (preview.generation || preview.comicGeneration) ? preview.error : null);

  return (
    <li className="entry-history-item">
      <Link
        className="entry-history-card"
        to={`/entries/${entry.id}`}
        state={backTo ? { backTo } : undefined}
      >
        <EntryThumbnail
          preview={preview}
          className="entry-history-art"
          iconSize={compact ? 24 : 30}
        />
        <span className="entry-history-copy">
          <strong className="entry-history-summary">{summarizeDiary(entry.body)}</strong>
          <span className="entry-history-meta">
            {showDate && <time dateTime={entry.diaryDate}>{formatDate(entry.diaryDate)}</time>}
            {statusLabel && <span>{statusLabel}</span>}
            {previewError && <span className="entry-history-preview-error">{previewError}</span>}
          </span>
        </span>
        <Icon name="chevron-right" size={20} />
      </Link>
      {preview.imageError && (
        <button
          className="entry-history-image-retry"
          type="button"
          aria-label="漫画画像を再読み込み"
          disabled={preview.isLoading}
          onClick={preview.retryImage}
        >
          <Icon name="refresh" size={18} />
        </button>
      )}
    </li>
  );
}

export function EntryHistory({
  entries,
  backTo,
  nextCursor = null,
  onLoadMore,
  busy = false,
  monthHeadings = false,
  compact = false,
  showDate = true,
  showStatus = !showDate,
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
                <EntryHistoryItem
                  entry={entry}
                  compact={compact}
                  showDate={showDate}
                  showStatus={showStatus}
                  backTo={backTo}
                  key={entry.id}
                />
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
