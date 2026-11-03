import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ComicDocument, EntryDetail } from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';
import { api, generate, getEntry, getAssetUrl } from '../../lib/api';
import type { ClientConfig } from '../../lib/config';
import { Comic } from '../comic/Comic';

function SavedComic({ comic, mock }: { comic: ComicDocument; mock: boolean }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
    Promise.all(ids.map(async (id) => [id, (await getAssetUrl(id)).url] as const))
      .then((result) => {
        if (active) setImages(Object.fromEntries(result));
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [comic]);
  return (
    <>
      {error && (
        <p role="alert" className="error">
          画像を取得できません。{error}
        </p>
      )}
      <Comic comic={comic} images={images} mock={mock} />
    </>
  );
}

function DetailContent({ id, config }: { id: string; config: ClientConfig }) {
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
  const generation = entry?.latestGeneration;
  const pending = generation?.status === 'queued' || generation?.status === 'running';
  const comicFromPreviousRevision =
    generation?.status === 'succeeded' && generation.entryRevision < (entry?.revision ?? 0);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let fetching = false;
    async function refresh() {
      if (document.hidden || fetching) return;
      fetching = true;
      try {
        const result = await getEntry(id);
        if (active) {
          setEntry(result);
          setError('');
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : '状態を取得できません。');
      } finally {
        fetching = false;
      }
    }
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => {
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, pending]);
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
            {entry.diaryDate} / {generation ? (generation.mock ? 'モック漫画' : '漫画') : '下書き'}
          </p>
          <h1>{summarizeDiary(entry.body)}</h1>
          <output className="saved">
            {config.dataMode === 'mock'
              ? '開発サーバーへ仮保存しました。'
              : `この匿名アカウントに保存しました。保存期間は最大${config.retentionDays}日です。`}
          </output>
          {comicFromPreviousRevision && <output>編集前の日記から生成された漫画です。</output>}
          {generation?.status === 'succeeded' && (
            <SavedComic key={generation.id} comic={generation.comic} mock={generation.mock} />
          )}
          {pending && (
            <output>
              {generation.status === 'queued' ? '生成待ちです。' : '漫画を作成しています。'}
            </output>
          )}
          {(generation?.status === 'failed' || generation?.status === 'unknown') && (
            <p role="alert" className="error">
              {generation.error.message}
              {generation.status === 'unknown' && ' 自動で再生成せず、結果の確認をお待ちください。'}
            </p>
          )}
          {generation?.status === 'cancelled' && <p>生成は中止されました。</p>}
          <section>
            <h2>元の日記</h2>
            <p className="diary">{entry.body}</p>
          </section>
          <div className="actions">
            {!entry.latestGeneration && (
              <button
                disabled={busy || config.dataMode !== 'mock' || !config.generationAvailable}
                onClick={() => void act(false)}
              >
                {config.dataMode === 'mock' && config.generationAvailable
                  ? 'モック漫画を見る'
                  : '漫画生成は利用できません'}
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

export function Detail({ config }: { config: ClientConfig }) {
  const { id = '' } = useParams();
  return <DetailContent key={id} id={id} config={config} />;
}
