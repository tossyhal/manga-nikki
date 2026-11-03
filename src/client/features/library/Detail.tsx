import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  jstToday,
  updateEntrySchema,
  type ComicDocument,
  type Entry,
  type EntryDetail,
} from '../../../shared/schemas';
import type { ClientConfig } from '../../lib/config';
import { ApiClientError, api, generate, getEntry, getAssetUrl } from '../../lib/api';
import { Comic } from '../comic/Comic';
import type { DiaryActivity } from '../diary/NewEntry';

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

function DetailContent({
  id,
  config,
  onActivityChange,
}: {
  id: string;
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
}) {
  const navigate = useNavigate();
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [editErrorStatus, setEditErrorStatus] = useState<number | null>(null);
  const activeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const draftDirty =
    editing && entry !== null && (draftDate !== entry.diaryDate || draftBody !== entry.body);

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      onActivityChange({ dirty: false, busy: false });
    };
  }, [onActivityChange]);

  useLayoutEffect(() => {
    if (activeRef.current) onActivityChange({ dirty: draftDirty, busy });
  }, [busy, draftDirty, onActivityChange]);

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

  function beginEditing() {
    if (!entry || pending) return;
    setDraftDate(entry.diaryDate);
    setDraftBody(entry.body);
    setEditErrorStatus(null);
    setError('');
    setEditing(true);
  }

  function cancelEditing() {
    if (!entry) return;
    setDraftDate(entry.diaryDate);
    setDraftBody(entry.body);
    setEditErrorStatus(null);
    setError('');
    setEditing(false);
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entry || pending || !activeRef.current || actionInFlightRef.current) return;
    const parsed = updateEntrySchema.safeParse({
      expectedRevision: entry.revision,
      diaryDate: draftDate,
      body: draftBody,
    });
    if (!parsed.success) {
      setError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      setEditErrorStatus(null);
      return;
    }

    setBusy(true);
    setError('');
    setEditErrorStatus(null);
    actionInFlightRef.current = true;
    try {
      const updated = await api<Entry>(`/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(parsed.data),
      });
      if (!activeRef.current) return;
      setEntry((current) =>
        current
          ? {
              ...current,
              ...updated,
              latestGeneration:
                current.latestGenerationId === updated.latestGenerationId
                  ? current.latestGeneration
                  : null,
            }
          : current,
      );
      setDraftDate(updated.diaryDate);
      setDraftBody(updated.body);
      setEditing(false);
      try {
        const latest = await getEntry(id);
        if (!activeRef.current) return;
        setEntry(latest);
        setDraftDate(latest.diaryDate);
        setDraftBody(latest.body);
      } catch {
        if (activeRef.current)
          setError('変更は保存しましたが、詳細の最新状態を読み込めませんでした。');
      }
    } catch (failure) {
      if (activeRef.current) {
        setError(failure instanceof Error ? failure.message : '変更を保存できませんでした。');
        setEditErrorStatus(failure instanceof ApiClientError ? failure.status : null);
      }
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function reloadLatest() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    if (
      draftDirty &&
      !window.confirm('編集中の入力を最新の記録で置き換えます。最新の記録を読み込みますか？')
    )
      return;

    setBusy(true);
    setError('');
    actionInFlightRef.current = true;
    try {
      const latest = await getEntry(id);
      if (!activeRef.current) return;
      setEntry(latest);
      setDraftDate(latest.diaryDate);
      setDraftBody(latest.body);
      const latestIsPending =
        latest.latestGeneration?.status === 'queued' ||
        latest.latestGeneration?.status === 'running';
      setEditing(!latestIsPending);
      if (latestIsPending) setError('この記録は生成中のため編集できません。');
      setEditErrorStatus(null);
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '最新の記録を読み込めませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

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
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (remove) {
        await api(`/entries/${entry.id}`, { method: 'DELETE' });
        if (!activeRef.current) return;
        onActivityChange({ dirty: false, busy: false });
        navigate('/library');
      } else {
        await generate(entry);
        if (!activeRef.current) return;
        const latest = await getEntry(id);
        if (!activeRef.current) return;
        setEntry(latest);
      }
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '操作できませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
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
          <h1>{generation?.status === 'succeeded' ? generation.comic.title : '今日の記録'}</h1>
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
          {editing && !pending ? (
            <form onSubmit={(event) => void saveEdit(event)}>
              <fieldset disabled={busy}>
                <label htmlFor="edit-date">日付</label>
                <input
                  id="edit-date"
                  type="date"
                  value={draftDate}
                  max={jstToday()}
                  onChange={(event) => setDraftDate(event.target.value)}
                  required
                />
                <label htmlFor="edit-body">日記</label>
                <textarea
                  id="edit-body"
                  rows={8}
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  placeholder="今日は何がありましたか？"
                  required
                  aria-describedby="edit-count"
                />
                <p id="edit-count" className="hint">
                  {[...draftBody.trim()].length} / 1,000文字
                </p>
              </fieldset>
              <div className="actions">
                <button disabled={busy || !draftDirty} type="submit">
                  {busy ? '保存しています…' : '変更を保存'}
                </button>
                <button className="secondary" disabled={busy} type="button" onClick={cancelEditing}>
                  編集をやめる
                </button>
                {editErrorStatus === 409 && (
                  <button
                    className="secondary"
                    disabled={busy}
                    type="button"
                    onClick={() => void reloadLatest()}
                  >
                    最新の記録を読み込む
                  </button>
                )}
              </div>
            </form>
          ) : (
            <>
              <section>
                <h2>元の日記</h2>
                <p className="diary">{entry.body}</p>
              </section>
              {!editing && (
                <div className="actions">
                  {!pending && (
                    <button className="secondary" disabled={busy} onClick={beginEditing}>
                      日記を編集
                    </button>
                  )}
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
              )}
            </>
          )}
        </>
      ) : (
        !error && <output>読み込んでいます…</output>
      )}
    </>
  );
}
export function Detail({
  config,
  onActivityChange,
}: {
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
}) {
  const { id = '' } = useParams();
  return <DetailContent key={id} id={id} config={config} onActivityChange={onActivityChange} />;
}
