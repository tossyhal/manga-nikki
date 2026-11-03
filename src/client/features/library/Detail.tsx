import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  jstToday,
  updateEntrySchema,
  type ComicDocument,
  type Entry,
  type EntryDetail,
  type Generation,
} from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';
import type { ClientConfig } from '../../lib/config';
import {
  ApiClientError,
  api,
  generate,
  getEntry,
  getGeneration,
  getQuotaForExistingSession,
  getAssetUrl,
  hasGenerationRequest,
  recheckGeneration,
  type GenerationQuota,
} from '../../lib/api';
import { Comic } from '../comic/Comic';
import type { DiaryActivity } from '../diary/NewEntry';
import { GenerationQuotaStatus } from '../diary/GenerationQuotaStatus';
import { RegistrationCaptcha } from '../diary/RegistrationCaptcha';

type QuotaState = 'loading' | 'ready' | 'session-required' | 'unavailable';

function quotaAllowsGeneration(quota: GenerationQuota | null): boolean {
  return Boolean(
    quota &&
    quota.generationAvailable &&
    quota.remainingToday > 0 &&
    quota.activeGenerationId === null,
  );
}

function generationStateMessage(generation: Generation): string {
  if (generation.status === 'unknown') {
    return '結果の確認を待っています。自動では再生成せず、利用枠を保持しています。状態を再確認してください。';
  }
  if (generation.status === 'failed') {
    return '漫画を作成できませんでした。日記は保存されています。再操作の前に最新の状態を確認してください。';
  }
  return '生成は中止されました。日記は保存されています。';
}

function generationStageMessage(generation: Generation): string {
  if (generation.status === 'queued') return '受付済みです。生成を待っています。';
  if (generation.status !== 'running') return '';
  if (generation.stage === 'script') return '構成（脚本）を作成しています。';
  if (generation.stage === 'images') return '画像を描いています。';
  return '漫画を保存しています。';
}

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
  const location = useLocation();
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [editErrorStatus, setEditErrorStatus] = useState<number | null>(null);
  const [quota, setQuota] = useState<GenerationQuota | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<Generation | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>('loading');
  const [generationCaptchaOpen, setGenerationCaptchaOpen] = useState(false);
  const [generationCaptchaRetry, setGenerationCaptchaRetry] = useState(false);
  const [generationCaptchaAttempt, setGenerationCaptchaAttempt] = useState(0);
  const [generationRequestSending, setGenerationRequestSending] = useState(false);
  const [receiptUncertain, setReceiptUncertain] = useState(false);
  const activeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const generationFlowRef = useRef(false);
  const generationRequestRef = useRef(false);
  const quotaRequestRef = useRef(0);
  const autoGenerationRequestedRef = useRef(
    Boolean(
      location.state &&
      typeof location.state === 'object' &&
      'startGeneration' in location.state &&
      location.state.startGeneration === true,
    ),
  );
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';
  const draftDirty =
    editing && entry !== null && (draftDate !== entry.diaryDate || draftBody !== entry.body);
  const openGenerationCaptcha = useCallback(
    (retry = false) => {
      if (generationFlowRef.current) return;
      if (!siteKey) {
        generationFlowRef.current = false;
        setError('生成用の確認を利用できません。保存した記録はこの画面から引き続き確認できます。');
        return;
      }
      generationFlowRef.current = true;
      setGenerationCaptchaRetry(retry);
      setGenerationCaptchaOpen(true);
      setGenerationCaptchaAttempt((attempt) => attempt + 1);
      setError('');
    },
    [siteKey],
  );

  const refreshQuota = useCallback(async (): Promise<GenerationQuota | null> => {
    const requestId = ++quotaRequestRef.current;
    try {
      const currentQuota = await getQuotaForExistingSession();
      if (!activeRef.current || requestId !== quotaRequestRef.current) return null;
      setQuota(currentQuota);
      if (!currentQuota) {
        setActiveGeneration(null);
        setQuotaState(config.dataMode === 'live' ? 'session-required' : 'unavailable');
        return null;
      }
      setQuotaState('ready');
      if (currentQuota.activeGenerationId) {
        const current = await getGeneration(currentQuota.activeGenerationId).catch(() => null);
        if (activeRef.current && requestId === quotaRequestRef.current) {
          setActiveGeneration(current);
          if (current?.entryId === id) {
            setEntry((existing) =>
              existing
                ? {
                    ...existing,
                    latestGenerationId: current.id,
                    latestGeneration: current,
                  }
                : existing,
            );
          }
        }
      } else {
        setActiveGeneration(null);
      }
      return currentQuota;
    } catch {
      if (activeRef.current && requestId === quotaRequestRef.current) {
        setQuota(null);
        setActiveGeneration(null);
        setQuotaState('unavailable');
      }
      return null;
    }
  }, [config.dataMode, id]);

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
    const refreshTimer = window.setTimeout(() => void refreshQuota(), 0);
    return () => window.clearTimeout(refreshTimer);
  }, [refreshQuota]);

  useEffect(() => {
    let active = true;
    getEntry(id)
      .then(async (result) => {
        if (!active || !result.latestGenerationId) {
          if (active) setEntry(result);
          return;
        }
        const latestGeneration = await getGeneration(result.latestGenerationId).catch(() => null);
        if (active) {
          setEntry(latestGeneration ? { ...result, latestGeneration } : result);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    if (autoGenerationRequestedRef.current && location.state !== null)
      navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);
  const generation = entry?.latestGeneration;
  const pending = generation?.status === 'queued' || generation?.status === 'running';
  const generationForCurrentRevision = generation?.entryRevision === entry?.revision;
  const unknownGeneration = generation?.status === 'unknown';
  const generationReferenceUnavailable = Boolean(entry?.latestGenerationId && !generation);
  const canStartGeneration =
    config.dataMode !== 'sample' &&
    config.generationAvailable &&
    !pending &&
    !generationForCurrentRevision &&
    !unknownGeneration &&
    !generationReferenceUnavailable &&
    quotaState === 'ready' &&
    quotaAllowsGeneration(quota) &&
    (config.dataMode !== 'live' || Boolean(siteKey));
  const hasUnresolvedRequest = Boolean(
    entry && !generationForCurrentRevision && hasGenerationRequest(entry),
  );
  const comicFromPreviousRevision =
    generation?.status === 'succeeded' && generation.entryRevision < (entry?.revision ?? 0);

  async function readLatestEntry(): Promise<EntryDetail> {
    let latest = await getEntry(id);
    if (latest.latestGenerationId) {
      const currentGeneration = await getGeneration(latest.latestGenerationId).catch(() => null);
      if (currentGeneration) latest = { ...latest, latestGeneration: currentGeneration };
    }
    return latest;
  }

  function applyGeneration(currentGeneration: Generation) {
    setActiveGeneration(currentGeneration);
    setEntry((current) =>
      current
        ? {
            ...current,
            latestGenerationId: currentGeneration.id,
            latestGeneration: currentGeneration,
          }
        : current,
    );
  }

  async function receiveGenerationReceipt(receipt: Awaited<ReturnType<typeof generate>>) {
    if (!activeRef.current) return;
    setGenerationCaptchaOpen(false);
    try {
      const currentGeneration = await getGeneration(receipt.generationId);
      if (!activeRef.current) return;
      applyGeneration(currentGeneration);
      setReceiptUncertain(false);
      setGenerationCaptchaRetry(false);
      setError('');
      await refreshQuota();
    } catch {
      if (!activeRef.current) return;
      setReceiptUncertain(true);
      setError('受付結果を受け取りましたが、状態を読み込めません。受付結果を再確認してください。');
    }
  }

  useEffect(() => {
    if (!autoGenerationRequestedRef.current || !entry || quotaState === 'loading') return;
    if (!canStartGeneration) {
      autoGenerationRequestedRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      autoGenerationRequestedRef.current = false;
      if (activeRef.current) openGenerationCaptcha();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canStartGeneration, entry, openGenerationCaptcha, quotaState]);

  async function submitGeneration(captchaToken = '') {
    if (!entry || !activeRef.current || generationRequestRef.current || actionInFlightRef.current)
      return;
    if (config.dataMode === 'live' && !captchaToken) {
      openGenerationCaptcha();
      return;
    }
    generationRequestRef.current = true;
    generationFlowRef.current = true;
    actionInFlightRef.current = true;
    setGenerationCaptchaOpen(false);
    setGenerationRequestSending(true);
    setBusy(true);
    setError('');
    try {
      const receipt = await generate(entry, captchaToken);
      if (!activeRef.current) return;
      await receiveGenerationReceipt(receipt);
    } catch (failure) {
      if (!activeRef.current) return;
      const apiFailure = failure instanceof ApiClientError ? failure : null;
      setError(failure instanceof Error ? failure.message : '漫画の受付を確認できませんでした。');
      if (apiFailure?.code === 'CAPTCHA_FAILED' || apiFailure?.code === 'CAPTCHA_REQUIRED') {
        setGenerationCaptchaRetry(true);
      } else if (apiFailure?.code === null) {
        setReceiptUncertain(true);
      }
      if (
        apiFailure?.code === 'USER_LIMIT_REACHED' ||
        apiFailure?.code === 'GLOBAL_LIMIT_REACHED' ||
        apiFailure?.code === 'TOO_MANY_ACTIVE' ||
        apiFailure?.code === 'GENERATION_DISABLED' ||
        apiFailure?.code === 'DEPENDENCY_UNAVAILABLE'
      )
        await refreshQuota();
      if (
        apiFailure?.code === 'ENTRY_BUSY' ||
        apiFailure?.code === 'IDEMPOTENCY_CONFLICT' ||
        apiFailure?.code === 'REVISION_CONFLICT'
      ) {
        const latest = await readLatestEntry().catch(() => null);
        if (activeRef.current && latest) setEntry(latest);
      }
    } finally {
      if (activeRef.current) {
        generationRequestRef.current = false;
        generationFlowRef.current = false;
        actionInFlightRef.current = false;
        setGenerationRequestSending(false);
        setBusy(false);
      }
    }
  }

  async function checkGenerationReceipt() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await recheckGeneration(entry);
      if (!activeRef.current) return;
      await receiveGenerationReceipt(receipt);
    } catch (failure) {
      if (!activeRef.current) return;
      const apiFailure = failure instanceof ApiClientError ? failure : null;
      setError(failure instanceof Error ? failure.message : '受付結果を確認できませんでした。');
      if (apiFailure?.code === 'CAPTCHA_FAILED' || apiFailure?.code === 'CAPTCHA_REQUIRED') {
        setGenerationCaptchaRetry(true);
      } else if (apiFailure?.code === null) {
        setReceiptUncertain(true);
      }
      if (
        apiFailure?.code === 'USER_LIMIT_REACHED' ||
        apiFailure?.code === 'GLOBAL_LIMIT_REACHED' ||
        apiFailure?.code === 'TOO_MANY_ACTIVE' ||
        apiFailure?.code === 'GENERATION_DISABLED' ||
        apiFailure?.code === 'DEPENDENCY_UNAVAILABLE'
      )
        await refreshQuota();
      if (
        apiFailure?.code === 'ENTRY_BUSY' ||
        apiFailure?.code === 'IDEMPOTENCY_CONFLICT' ||
        apiFailure?.code === 'REVISION_CONFLICT'
      ) {
        const latest = await readLatestEntry().catch(() => null);
        if (activeRef.current && latest) setEntry(latest);
      }
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function refreshGenerationStatus() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const latest = await readLatestEntry();
      if (!activeRef.current) return;
      setEntry(latest);
      setDraftDate(latest.diaryDate);
      setDraftBody(latest.body);
      setReceiptUncertain(false);
      await refreshQuota();
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '最新の状態を読み込めませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

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
        const latest = await readLatestEntry();
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
      const latest = await readLatestEntry();
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
    const generationId = generation?.id;
    if (!pending || !generationId) return;
    let active = true;
    let fetching = false;
    async function refresh() {
      if (document.hidden || fetching) return;
      fetching = true;
      try {
        const result = await getGeneration(generationId!);
        if (active && activeRef.current) {
          applyGeneration(result);
          setError('');
          if (result.status !== 'queued' && result.status !== 'running') void refreshQuota();
        }
      } catch (failure) {
        if (active && activeRef.current)
          setError(failure instanceof Error ? failure.message : '状態を取得できません。');
      } finally {
        fetching = false;
      }
    }
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => {
      void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [generation?.id, pending, refreshQuota]);

  async function removeEntry() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/entries/${entry.id}`, { method: 'DELETE' });
      if (!activeRef.current) return;
      onActivityChange({ dirty: false, busy: false });
      navigate('/library');
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
            {entry.diaryDate} /{' '}
            {generation ? (generation.mock ? '固定サンプル' : '漫画') : '下書き'}
          </p>
          <h1>{summarizeDiary(entry.body)}</h1>
          <output className="saved">
            {config.dataMode === 'mock'
              ? '一時保存しました。'
              : `この匿名アカウントに保存しました。保存後${config.retentionDays}日を過ぎると閲覧できなくなります。`}
          </output>
          {config.dataMode !== 'sample' &&
            config.generationAvailable &&
            !(generation?.status === 'succeeded' && generation.mock) && (
              <p className="hint">固定サンプルです。入力内容は反映されず、AIにも送信されません。</p>
            )}
          {quota && (
            <GenerationQuotaStatus
              quota={quota}
              activeGeneration={activeGeneration}
              currentEntryId={entry.id}
              currentGenerationId={generation?.id ?? null}
            />
          )}
          {quotaState === 'session-required' && (
            <p className="hint" role="alert">
              保存済みの匿名セッションを確認できないため、漫画の受付を停止しています。別の匿名アカウントは自動で作成しません。
            </p>
          )}
          {quotaState === 'unavailable' && (
            <p className="hint" role="alert">
              利用枠を確認できないため、漫画の受付を停止しています。日記の閲覧と保存は続けられます。
            </p>
          )}
          {comicFromPreviousRevision && <output>編集前の日記から生成された漫画です。</output>}
          {generation?.status === 'succeeded' && (
            <SavedComic key={generation.id} comic={generation.comic} mock={generation.mock} />
          )}
          {pending && <output>{generationStageMessage(generation)}</output>}
          {(generation?.status === 'failed' || generation?.status === 'unknown') && (
            <p role="alert" className="error">
              {generationStateMessage(generation)}
            </p>
          )}
          {generation?.status === 'cancelled' && <p>{generationStateMessage(generation)}</p>}
          {generationReferenceUnavailable && (
            <p className="hint" role="alert">
              漫画の最新状態を確認できないため、新しい受付を停止しています。状態を再確認してください。
            </p>
          )}
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
                  {!generationForCurrentRevision && hasUnresolvedRequest && (
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void checkGenerationReceipt()}
                    >
                      {busy
                        ? generationRequestSending
                          ? '受付しています…'
                          : '受付結果を確認しています…'
                        : '受付結果を確認'}
                    </button>
                  )}
                  {!generationForCurrentRevision && !hasUnresolvedRequest && (
                    <button
                      disabled={busy || generationCaptchaOpen || !canStartGeneration}
                      type="button"
                      onClick={() =>
                        config.dataMode === 'live'
                          ? openGenerationCaptcha()
                          : void submitGeneration()
                      }
                    >
                      {busy
                        ? '受付しています…'
                        : !config.generationAvailable
                          ? '漫画の受付を停止しています'
                          : quotaState === 'loading'
                            ? '利用枠を確認しています…'
                            : quotaState === 'unavailable' || quotaState === 'session-required'
                              ? '利用枠を確認できません'
                              : quota?.remainingToday === 0
                                ? '本日の生成上限に達しています'
                                : quota?.activeGenerationId
                                  ? '進行中の漫画を確認してください'
                                  : quota && !quota.generationAvailable
                                    ? '漫画の受付を停止しています'
                                    : unknownGeneration
                                      ? '結果を確認してください'
                                      : generationReferenceUnavailable
                                        ? '生成状態を確認してください'
                                        : config.dataMode === 'live' && !siteKey
                                          ? '生成用の確認を利用できません'
                                          : config.dataMode === 'mock'
                                            ? '固定サンプルを見る'
                                            : '漫画を作成する'}
                    </button>
                  )}
                  {generationCaptchaRetry &&
                    config.dataMode === 'live' &&
                    !generationCaptchaOpen && (
                      <button
                        className="secondary"
                        disabled={busy}
                        type="button"
                        onClick={() => openGenerationCaptcha(true)}
                      >
                        新しい確認を取得
                      </button>
                    )}
                  {(quotaState === 'unavailable' || quotaState === 'session-required') && (
                    <button
                      className="secondary"
                      disabled={busy}
                      type="button"
                      onClick={() => {
                        setQuotaState('loading');
                        void refreshQuota();
                      }}
                    >
                      利用枠を再確認
                    </button>
                  )}
                  {(receiptUncertain || hasUnresolvedRequest) && (
                    <p className="hint">
                      受付結果が不明な場合も、同じ記録の受付を再確認します。自動で新しい生成は始めません。
                    </p>
                  )}
                  {(generation?.status === 'failed' ||
                    generation?.status === 'unknown' ||
                    generation?.status === 'cancelled' ||
                    generationReferenceUnavailable) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      type="button"
                      onClick={() => void refreshGenerationStatus()}
                    >
                      {busy ? '状態を確認しています…' : '状態を再確認'}
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('この記録を削除しますか？')) void removeEntry();
                    }}
                  >
                    記録を削除
                  </button>
                </div>
              )}
            </>
          )}
          {generationCaptchaOpen && config.dataMode === 'live' && (
            <section aria-label="漫画生成の確認">
              <p>漫画の受付を続けるため、生成用の確認を行います。</p>
              {siteKey ? (
                <RegistrationCaptcha
                  key={`generate-${generationCaptchaAttempt}`}
                  action="generate"
                  label="漫画生成用の確認"
                  siteKey={siteKey}
                  requestKey={generationCaptchaAttempt}
                  onToken={(token) => {
                    if (activeRef.current) void submitGeneration(token);
                  }}
                  onError={() => {
                    if (!activeRef.current || generationRequestRef.current) return;
                    generationFlowRef.current = false;
                    setGenerationCaptchaOpen(false);
                    setGenerationCaptchaRetry(true);
                    setError(
                      '確認に失敗しました。保存済みの日記はそのままです。新しい確認を取得して再操作してください。',
                    );
                  }}
                />
              ) : (
                <p role="alert" className="error">
                  生成用の確認を利用できません。保存した記録はこの画面から引き続き確認できます。
                </p>
              )}
            </section>
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
