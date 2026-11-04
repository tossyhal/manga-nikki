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
import { ConfirmDialog } from '../../app/ConfirmDialog';
import { Icon } from '../../app/Icon';

type QuotaState = 'loading' | 'ready' | 'session-required' | 'unavailable';

function quotaAllowsGeneration(quota: GenerationQuota | null): boolean {
  return Boolean(
    quota &&
    quota.generationAvailable &&
    quota.remainingToday > 0 &&
    quota.activeGenerationId === null,
  );
}

function generationActionErrorMessage(failure: unknown, fallback: string): string {
  if (failure instanceof ApiClientError && failure.code === 'DEPENDENCY_UNAVAILABLE') {
    return '漫画の受付を利用できません。時間をおいて再操作してください。';
  }
  return failure instanceof Error ? failure.message : fallback;
}

function generationStateMessage(generation: Generation): string {
  if (generation.status === 'unknown') {
    return '結果の確認を待っています。自動では再生成せず、利用枠を保持しています。状態を再確認してください。';
  }
  if (generation.status === 'failed') {
    return '漫画を作成できませんでした。日記は保存されています。本文を編集して保存すると新しく受付できます。利用枠は上の残り回数を確認してください。';
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

function formatEntryDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '日付を選択';
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date)
    return '日付を選択';
  const monthDay = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
  }).format(value);
  const weekday = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(value);
  return `${monthDay} ${weekday}`;
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
  const [editTyping, setEditTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardEditConfirmOpen, setDiscardEditConfirmOpen] = useState(false);
  const [reloadLatestConfirmOpen, setReloadLatestConfirmOpen] = useState(false);
  const [journalExpanded, setJournalExpanded] = useState(false);
  const activeRef = useRef(true);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionInFlightRef = useRef(false);
  const generationFlowRef = useRef(false);
  const generationCaptchaAttemptRef = useRef(0);
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
      const attempt = generationCaptchaAttemptRef.current + 1;
      generationCaptchaAttemptRef.current = attempt;
      setGenerationCaptchaAttempt(attempt);
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
    const root = document.documentElement;
    const useInlineActions = editTyping && window.matchMedia('(max-width: 700px)').matches;
    root.classList.toggle('entry-keyboard-active', useInlineActions);
    return () => root.classList.remove('entry-keyboard-active');
  }, [editTyping]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);

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
  const stageIndex =
    generation?.status === 'running'
      ? ['script', 'images', 'saving'].indexOf(generation.stage)
      : -1;
  const showGenerationAction = Boolean(
    !pending &&
    !unknownGeneration &&
    !generationReferenceUnavailable &&
    !generationForCurrentRevision &&
    !hasUnresolvedRequest,
  );

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
    if (!autoGenerationRequestedRef.current || !entry) return;
    if (editing) {
      autoGenerationRequestedRef.current = false;
      return;
    }
    if (quotaState === 'loading') return;
    if (!canStartGeneration) {
      autoGenerationRequestedRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      autoGenerationRequestedRef.current = false;
      if (activeRef.current) openGenerationCaptcha();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canStartGeneration, editing, entry, openGenerationCaptcha, quotaState]);

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
      setError(generationActionErrorMessage(failure, '漫画の受付を確認できませんでした。'));
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
      setError(generationActionErrorMessage(failure, '受付結果を確認できませんでした。'));
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
    if (!entry || pending || busy || actionInFlightRef.current) return;
    autoGenerationRequestedRef.current = false;
    if (generationFlowRef.current) {
      generationFlowRef.current = false;
      generationCaptchaAttemptRef.current += 1;
      setGenerationCaptchaOpen(false);
      setGenerationCaptchaRetry(false);
    }
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

  function requestReloadLatest() {
    if (draftDirty) {
      setReloadLatestConfirmOpen(true);
      return;
    }
    void reloadLatest();
  }

  function requestCancelEditing() {
    if (!draftDirty) {
      cancelEditing();
      return;
    }
    setDiscardEditConfirmOpen(true);
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
    <div className="detail-page">
      {entry && !editing && (
        <header className="detail-toolbar">
          <Link className="icon-button" to="/library" aria-label="記録の一覧へ戻る">
            <Icon name="back" />
          </Link>
          <h1 className="detail-title">{summarizeDiary(entry.body)}</h1>
          <div className="detail-menu-anchor">
            <button
              ref={menuTriggerRef}
              className="icon-button"
              type="button"
              aria-label="その他の操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="more" />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                className="detail-menu"
                role="menu"
                aria-label="記録の操作"
                tabIndex={-1}
                onKeyDown={(event) => {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]:not(:disabled)',
                    ),
                  );
                  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setMenuOpen(false);
                    menuTriggerRef.current?.focus();
                  } else if (event.key === 'ArrowDown' && items.length > 0) {
                    event.preventDefault();
                    items[(currentIndex + 1) % items.length]?.focus();
                  } else if (event.key === 'ArrowUp' && items.length > 0) {
                    event.preventDefault();
                    items[(currentIndex - 1 + items.length) % items.length]?.focus();
                  } else if (event.key === 'Home' && items.length > 0) {
                    event.preventDefault();
                    items[0]?.focus();
                  } else if (event.key === 'End' && items.length > 0) {
                    event.preventDefault();
                    items.at(-1)?.focus();
                  }
                }}
              >
                {!pending && (
                  <button
                    className="detail-menu-item"
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false);
                      beginEditing();
                    }}
                  >
                    <Icon name="edit" size={19} />
                    <span>日記を編集</span>
                  </button>
                )}
                <button
                  className="detail-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteConfirmOpen(true);
                  }}
                >
                  <Icon name="trash" size={19} />
                  <span>日記を削除</span>
                </button>
              </div>
            )}
          </div>
        </header>
      )}
      {entry && editing && (
        <header className="detail-edit-toolbar">
          <button
            className="icon-button"
            type="button"
            aria-label="編集をやめる"
            onClick={requestCancelEditing}
          >
            <Icon name="back" />
          </button>
          <h1>日記を編集</h1>
          <button
            className="button-text"
            type="submit"
            form="edit-entry-form"
            disabled={busy || !draftDirty}
          >
            {busy ? '保存中' : '保存'}
          </button>
        </header>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {entry ? (
        <>
          {!editing && (
            <div className="detail-date-row">
              <time dateTime={entry.diaryDate}>{formatEntryDate(entry.diaryDate)}</time>
              {generation?.mock && <span className="sample-tag">固定サンプル</span>}
            </div>
          )}
          <output className="detail-save-status">
            {config.dataMode === 'mock'
              ? '一時保存しました。'
              : `この匿名アカウントに保存しました。保存後${config.retentionDays}日を過ぎると閲覧できなくなります。`}
          </output>
          {config.dataMode !== 'sample' &&
            config.generationAvailable &&
            !(generation?.status === 'succeeded' && generation.mock) && (
              <p className="hint">
                このアプリの漫画は固定サンプルです。入力内容は反映されず、AIにも送信されません。
              </p>
            )}
          {quota && (
            <div className="detail-quota-card">
              <GenerationQuotaStatus
                quota={quota}
                activeGeneration={activeGeneration}
                currentEntryId={entry.id}
                currentGenerationId={generation?.id ?? null}
              />
            </div>
          )}
          {quotaState === 'session-required' && (
            <p className="inline-alert" role="alert">
              保存済みの匿名セッションを確認できないため、漫画の受付を停止しています。別の匿名アカウントは自動で作成しません。
            </p>
          )}
          {quotaState === 'unavailable' && (
            <p className="inline-alert" role="alert">
              利用枠を確認できないため、漫画の受付を停止しています。日記の閲覧と保存は続けられます。
            </p>
          )}
          {comicFromPreviousRevision && (
            <p className="detail-revision-note">編集前の日記から生成された漫画です。</p>
          )}

          {editing && !pending ? (
            <form
              id="edit-entry-form"
              className="entry-form detail-edit-form"
              onSubmit={(event) => void saveEdit(event)}
            >
              <fieldset disabled={busy} className="entry-form-fields">
                <div className="date-row">
                  <label className="date-display" htmlFor="edit-date">
                    <time dateTime={draftDate}>{formatEntryDate(draftDate)}</time>
                    <Icon name="calendar" size={20} />
                  </label>
                  <input
                    id="edit-date"
                    aria-label="日付"
                    className="date-picker-input"
                    type="date"
                    value={draftDate}
                    max={jstToday()}
                    onChange={(event) => setDraftDate(event.target.value)}
                    required
                  />
                </div>
                <div className="entry-editor-card">
                  <label className="entry-editor-title" htmlFor="edit-body">
                    日記
                  </label>
                  <textarea
                    id="edit-body"
                    aria-label="日記"
                    rows={8}
                    value={draftBody}
                    onChange={(event) => setDraftBody(event.target.value)}
                    placeholder="今日はどんな日だった？"
                    required
                    aria-describedby="edit-count"
                    onFocus={() => setEditTyping(true)}
                    onBlur={() => setEditTyping(false)}
                  />
                  <div className="entry-editor-footer">
                    <span />
                    <p id="edit-count" className="character-count">
                      {[...draftBody.trim()].length} / 1,000文字
                    </p>
                  </div>
                </div>
              </fieldset>
              {editErrorStatus === 409 && (
                <button
                  className="button button-secondary latest-entry-action"
                  disabled={busy}
                  type="button"
                  onClick={requestReloadLatest}
                >
                  最新の記録を読み込む
                </button>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button
                className="button-text edit-cancel-action"
                disabled={busy}
                type="button"
                onClick={requestCancelEditing}
              >
                編集をやめる
              </button>
            </form>
          ) : (
            <>
              {generation?.status === 'succeeded' && (
                <SavedComic key={generation.id} comic={generation.comic} mock={generation.mock} />
              )}
              {generation?.status === 'queued' && (
                <section className="generation-card" aria-live="polite">
                  <Icon name="clock" size={40} />
                  <h2>生成を受け付けました</h2>
                  <p>順番に処理しています。</p>
                  <p className="generation-card-note">画面を閉じても、あとで確認できます。</p>
                </section>
              )}
              {generation?.status === 'running' && (
                <section className="generation-card" aria-live="polite">
                  <Icon name="clock" size={40} />
                  <h2>
                    {generation.stage === 'script'
                      ? '物語を考えています'
                      : generation.stage === 'images'
                        ? '4コマを描いています'
                        : 'もうすぐ完成です'}
                  </h2>
                  <p>{generationStageMessage(generation)}</p>
                  <ol className="generation-steps" aria-label="生成の進行段階">
                    {['構成を考える', '絵を描く', '保存する'].map((label, index) => (
                      <li
                        key={label}
                        className={
                          index < stageIndex
                            ? 'is-complete'
                            : index === stageIndex
                              ? 'is-current'
                              : ''
                        }
                        aria-current={index === stageIndex ? 'step' : undefined}
                      >
                        <span className="generation-step-icon" aria-hidden="true">
                          {index < stageIndex ? <Icon name="check" size={14} /> : null}
                        </span>
                        {label}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {generation?.status === 'unknown' && (
                <section className="generation-card" aria-live="polite">
                  <Icon name="clock" size={40} />
                  <h2>生成結果を確認中</h2>
                  <p>{generationStateMessage(generation)}</p>
                </section>
              )}
              {generation?.status === 'failed' && (
                <section className="generation-card" role="alert">
                  <Icon name="alert" size={40} />
                  <h2>生成に失敗しました</h2>
                  <p>{generationStateMessage(generation)}</p>
                </section>
              )}
              {generation?.status === 'cancelled' && (
                <section className="generation-card">
                  <Icon name="close" size={40} />
                  <h2>生成はキャンセルされました</h2>
                  <p>{generationStateMessage(generation)}</p>
                </section>
              )}
              {generationReferenceUnavailable && (
                <section className="generation-card" role="alert">
                  <Icon name="alert" size={40} />
                  <h2>漫画の状態を確認できません</h2>
                  <p>状態が確認できるまで新しい生成は受け付けません。</p>
                </section>
              )}
              {!generation && !generationReferenceUnavailable && (
                <section className="entry-draft-card">
                  <p className="diary">{entry.body}</p>
                  <button className="button button-secondary" type="button" onClick={beginEditing}>
                    <Icon name="edit" size={18} />
                    日記を編集
                  </button>
                </section>
              )}
              {generation && (
                <details
                  id="original-diary"
                  className="original-diary"
                  open={journalExpanded}
                  onToggle={(event) => setJournalExpanded(event.currentTarget.open)}
                >
                  <summary>{journalExpanded ? '元の日記を閉じる' : '元の日記を読む'}</summary>
                  <p className="diary">{entry.body}</p>
                </details>
              )}
              {generationCaptchaOpen && config.dataMode === 'live' && (
                <section className="captcha-card" aria-label="漫画生成の確認">
                  <p>漫画の受付を続けるため、生成用の確認を行います。</p>
                  {siteKey ? (
                    <RegistrationCaptcha
                      key={`generate-${generationCaptchaAttempt}`}
                      action="generate"
                      label="漫画生成用の確認"
                      siteKey={siteKey}
                      requestKey={generationCaptchaAttempt}
                      onToken={(token) => {
                        if (
                          !activeRef.current ||
                          !generationFlowRef.current ||
                          generationCaptchaAttemptRef.current !== generationCaptchaAttempt ||
                          generationRequestRef.current
                        )
                          return;
                        if (actionInFlightRef.current) {
                          generationFlowRef.current = false;
                          generationCaptchaAttemptRef.current += 1;
                          setGenerationCaptchaOpen(false);
                          setGenerationCaptchaRetry(true);
                          setError(
                            '別の操作中に確認が完了しました。漫画の受付はしていません。新しい確認を取得して再操作してください。',
                          );
                          return;
                        }
                        void submitGeneration(token);
                      }}
                      onError={() => {
                        if (
                          !activeRef.current ||
                          generationRequestRef.current ||
                          !generationFlowRef.current ||
                          generationCaptchaAttemptRef.current !== generationCaptchaAttempt
                        )
                          return;
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
              {generationCaptchaRetry && config.dataMode === 'live' && !generationCaptchaOpen && (
                <button
                  className="button button-secondary"
                  disabled={busy}
                  type="button"
                  onClick={() => openGenerationCaptcha(true)}
                >
                  新しい確認を取得
                </button>
              )}
              {(receiptUncertain || hasUnresolvedRequest) && (
                <p className="hint">
                  受付結果が不明な場合も、同じ記録の受付を再確認します。自動で新しい生成は始めません。
                </p>
              )}
            </>
          )}
        </>
      ) : (
        !error && <output>読み込んでいます…</output>
      )}
      {entry && !editing && (
        <div className="primary-action-dock detail-action-dock">
          {pending && (
            <Link className="button button-primary" to="/library">
              記録を見る
            </Link>
          )}
          {generation?.status === 'unknown' && (
            <button
              className="button button-primary"
              disabled={busy}
              type="button"
              onClick={() => void refreshGenerationStatus()}
            >
              {busy ? '状態を確認しています…' : '状態を確認する'}
            </button>
          )}
          {generation?.status === 'failed' && (
            <button
              className="button button-primary"
              type="button"
              onClick={() => {
                setJournalExpanded(true);
                document.getElementById('original-diary')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              保存した日記を見る
            </button>
          )}
          {generation?.status === 'cancelled' && (
            <button className="button button-primary" type="button" onClick={beginEditing}>
              日記に戻る
            </button>
          )}
          {(receiptUncertain || hasUnresolvedRequest) && !pending && (
            <button
              className="button button-primary"
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
          {generationReferenceUnavailable && (
            <button
              className="button button-primary"
              disabled={busy}
              type="button"
              onClick={() => void refreshGenerationStatus()}
            >
              状態を再確認する
            </button>
          )}
          {showGenerationAction && (
            <button
              className="button button-primary"
              disabled={busy || generationCaptchaOpen || !canStartGeneration}
              type="button"
              onClick={() =>
                config.dataMode === 'live' ? openGenerationCaptcha() : void submitGeneration()
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
                      : quota?.generationAvailable === false
                        ? '漫画の受付を停止しています'
                        : quota?.remainingToday === 0
                          ? '本日の生成上限に達しています'
                          : quota?.activeGenerationId
                            ? '進行中の漫画を確認してください'
                            : !config.generationAvailable
                              ? '漫画の受付を停止しています'
                              : config.dataMode === 'live' && !siteKey
                                ? '生成用の確認を利用できません'
                                : '4コマにする'}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="この日記を削除しますか？"
        description="削除すると漫画も見られなくなります。"
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        icon="trash"
        destructive
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          void removeEntry();
        }}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
      <ConfirmDialog
        open={discardEditConfirmOpen}
        title="編集内容が保存されていません"
        description="変更を破棄して、記録に戻りますか？"
        confirmLabel="変更を破棄"
        cancelLabel="編集に戻る"
        cancelPrimary
        onConfirm={() => {
          setDiscardEditConfirmOpen(false);
          cancelEditing();
        }}
        onCancel={() => setDiscardEditConfirmOpen(false)}
      />
      <ConfirmDialog
        open={reloadLatestConfirmOpen}
        title="最新の記録を読み込みますか？"
        description="編集中の入力を最新の記録で置き換えます。"
        confirmLabel="最新の記録を読み込む"
        cancelLabel="編集に戻る"
        onConfirm={() => {
          setReloadLatestConfirmOpen(false);
          void reloadLatest();
        }}
        onCancel={() => setReloadLatestConfirmOpen(false)}
      />
    </div>
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
