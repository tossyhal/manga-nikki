import { formatDiaryDate } from '../../lib/diaryDate';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Entry } from '../../../shared/schemas';
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
import { useJstToday } from '../../lib/useJstToday';

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

function TodayEntryHero({ entry }: { entry: Entry }) {
  const preview = useEntryPreview(entry, { eager: true });
  let placeholder = '漫画はまだありません';
  if (preview.isLoading) placeholder = '漫画を読み込んでいます';
  else if (preview.imageError) placeholder = '漫画画像を表示できません';
  else if (preview.error && !preview.generation) placeholder = '記録の状態を確認できません';
  else if (preview.generation?.status === 'queued' || preview.generation?.status === 'running')
    placeholder = '漫画を作成中';
  else if (preview.generation?.status === 'unknown') placeholder = '生成結果を確認中';
  else if (preview.generation?.status === 'failed') placeholder = '漫画を生成できませんでした';
  else if (preview.generation?.status === 'cancelled') placeholder = '生成を終了しました';
  const hasComic = Boolean(preview.comicGeneration);
  const latestGenerationMessage = hasComic
    ? preview.generation?.status === 'queued' || preview.generation?.status === 'running'
      ? '新しい漫画を作成中です。'
      : preview.generation?.status === 'unknown'
        ? '新しい漫画の生成結果を確認中です。'
        : preview.generation?.status === 'failed'
          ? '新しい漫画を生成できませんでした。'
          : preview.generation?.status === 'cancelled'
            ? '新しい漫画の生成を終了しました。'
            : null
    : null;
  const comicTitle =
    preview.comicGeneration?.status === 'succeeded'
      ? preview.comicGeneration.comic.title
      : summarizeDiary(entry.body);
  return (
    <div className="home-today-hero">
      <div className="home-today-content">
        <h2>{summarizeDiary(entry.body)}</h2>
        {preview.isStale && <p>編集前の漫画を表示しています。</p>}
        {latestGenerationMessage && <p>{latestGenerationMessage}</p>}
        {preview.error && (preview.generation || preview.comicGeneration) && (
          <p>最新の状態を確認できません。</p>
        )}
        {preview.imageError && <p>{preview.imageError}</p>}
        <Link className="today-write-link" to={`/entries/${encodeURIComponent(entry.id)}`}>
          <span>{hasComic ? '漫画を読む' : '記録を読む'}</span>
          <Icon name="chevron-right" size={18} />
        </Link>
      </div>
      <div className="home-today-image">
        <Link
          className="home-today-image-link"
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
        {preview.imageError && (
          <button
            className="thumbnail-retry-button"
            type="button"
            aria-label="漫画画像を再読み込み"
            aria-disabled={preview.isLoading}
            onClick={() => {
              if (!preview.isLoading) preview.retryImage();
            }}
          >
            <Icon name="refresh" size={18} />
          </button>
        )}
      </div>
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
  const location = useLocation();
  const navigate = useNavigate();
  const [recordsRetry, setRecordsRetry] = useState(0);
  const records = useHomeRecords(config, configError, recordsRetry);
  const showSample = records.status === 'sample';
  const entries = records.status === 'ready' ? records.entries : [];
  const today = useJstToday();
  const todayEntries = entries.filter((entry) => entry.diaryDate === today);
  const todayEntry = todayEntries[0] ?? null;
  const recentEntries = entries.filter((entry) => entry.id !== todayEntry?.id).slice(0, 2);
  const sampleOpen = new URLSearchParams(location.search).get('sample') === '1';
  const openedSampleInApp =
    (location.state as { openedSampleInApp?: boolean } | null)?.openedSampleInApp === true;
  const openSample = () => navigate('/?sample=1', { state: { openedSampleInApp: true } });
  const closeSample = () => {
    if (openedSampleInApp) navigate(-1);
    else navigate('/', { replace: true });
  };

  if (showSample && sampleOpen) {
    return (
      <section className="sample-detail" aria-labelledby="sample-detail-title">
        <div className="detail-toolbar">
          <button className="icon-button" type="button" onClick={closeSample}>
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
      <time className="home-date" dateTime={today}>
        {formatDiaryDate(today)}
      </time>
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
                <button className="button button-secondary" type="button" onClick={openSample}>
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
                <button className="today-write-link" type="button" onClick={openSample}>
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
