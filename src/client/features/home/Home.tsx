import { formatDiaryDate } from '../../lib/diaryDate';
import { useState } from 'react';
import { Link } from 'react-router';
import { type Entry, type Generation } from '../../../shared/schemas';
import { jstToday } from '../../../shared/date';
import { pageComic, sampleDiary } from '../../../shared/fixtures';
import { summarizeDiary } from '../../../shared/summary';
import catSleeping from '../../../../design/assets/cat_sleeping.svg?url';
import { Comic } from '../comic/Comic';
import { EntryHistory } from '../library/EntryHistory';
import { EntryThumbnail, useEntryPreview } from '../library/EntryPreview';
import type { ClientConfig } from '../../lib/config';
import { Icon } from '../../app/Icon';
import { AppStateCard, configUnavailableMessage } from '../../app/AppStateCard';
import { useHomeRecords } from './useHomeRecords';

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
  comicGeneration?: Generation | null,
) {
  if (!generation) {
    if (entry.latestGenerationId) {
      if (error) return '記録の状態を確認できません';
      return loading ? '状態を確認しています' : '記録の状態を確認できません';
    }
    return comicGeneration ? '編集前の漫画' : '下書き';
  }
  if (generation.entryRevision !== entry.revision)
    return comicGeneration ? '編集前の漫画' : '編集済み';
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
  let placeholder = '漫画はまだありません';
  if (preview.isLoading) placeholder = '漫画を読み込んでいます';
  else if (preview.imageError) placeholder = '漫画画像を表示できません';
  else if (preview.error && !preview.generation) placeholder = '記録の状態を確認できません';
  else if (preview.generation?.status === 'queued' || preview.generation?.status === 'running')
    placeholder = '漫画を作成中';
  else if (preview.generation?.status === 'failed' || preview.generation?.status === 'cancelled')
    placeholder = '漫画はありません';
  const hasComic = Boolean(preview.comicGeneration);
  const comicTitle =
    preview.comicGeneration?.status === 'succeeded'
      ? preview.comicGeneration.comic.title
      : summarizeDiary(entry.body);
  const label = generationLabel(
    preview.generation,
    entry,
    preview.isLoading,
    preview.error,
    preview.comicGeneration,
  );

  return (
    <div className="home-today-hero">
      <div className="home-today-content">
        <h2>{summarizeDiary(entry.body)}</h2>
        <p>{label}</p>
        {preview.isStale && <p>編集前の漫画を表示しています。</p>}
        {preview.error && (preview.generation || preview.comicGeneration) && (
          <p>最新の状態を確認できません。</p>
        )}
        {preview.imageError && <p>{preview.imageError}</p>}
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

export function Home({
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
  const currentDay = jstToday();
  const todayEntries = entries.filter((entry) => entry.diaryDate === currentDay);
  const todayEntry = todayEntries[0] ?? null;
  const recentEntries = entries.filter((entry) => entry.id !== todayEntry?.id).slice(0, 2);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [today] = useState(() => {
    const date = jstToday();
    return { date, label: formatDiaryDate(date) };
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
