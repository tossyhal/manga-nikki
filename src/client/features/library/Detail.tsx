import { useEntryEditor } from './useEntryEditor';
import { useGenerationQuota, quotaAllowsGeneration } from '../diary/useGenerationQuota';
import { useGenerationPolling } from './useGenerationPolling';
import { GenerationStatusCard } from './GenerationStatusCard';
import { DetailToolbar } from './DetailToolbar';
import { DiaryDateField } from '../diary/DiaryDateField';
import { DiaryBodyField } from '../diary/DiaryBodyField';
import { formatDiaryDate } from '../../lib/diaryDate';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { type EntryDetail, type Generation } from '../../../shared/schemas';
import { summarizeDiary } from '../../../shared/summary';
import type { ClientConfig } from '../../lib/config';
import {
  ApiClientError,
  api,
  generate,
  getEntry,
  getGeneration,
  hasGenerationRequest,
  recheckGeneration,
} from '../../lib/api';
import { SavedComic } from '../comic/SavedComic';
import { validateLibraryBackTo } from './librarySearch';
import type { DiaryActivity } from '../diary/diaryActivity';
import { GenerationQuotaStatus } from '../diary/GenerationQuotaStatus';
import { RegistrationCaptcha } from '../diary/RegistrationCaptcha';
import { ConfirmDialog } from '../../app/ConfirmDialog';
import { Icon } from '../../app/Icon';
import { mergeEntryGenerationProgress } from './generationProgress';
import { completeEntryDetail, isCurrentEntryGeneration } from './entryDetail';

function generationActionErrorMessage(failure: unknown, fallback: string): string {
  if (failure instanceof ApiClientError && failure.code === 'DEPENDENCY_UNAVAILABLE') {
    return '漫画の受付を利用できません。時間をおいて再操作してください。';
  }
  return failure instanceof Error ? failure.message : fallback;
}

function DetailContent({
  id,
  config,
  onActivityChange,
  hasBlockedNavigation,
}: {
  id: string;
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
  hasBlockedNavigation: () => boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const backTo =
    location.state && typeof location.state === 'object' && 'backTo' in location.state
      ? (validateLibraryBackTo(location.state.backTo) ?? '/library')
      : '/library';
  const draftSavedNavigation = Boolean(
    location.state &&
    typeof location.state === 'object' &&
    'draftSaved' in location.state &&
    location.state.draftSaved === true,
  );
  const [draftSavedEntryId, setDraftSavedEntryId] = useState<string | null>(() =>
    draftSavedNavigation ? id : null,
  );
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const entryRef = useRef<EntryDetail | null>(null);
  const detailReadVersionRef = useRef(0);
  const setEntrySafely: Dispatch<SetStateAction<EntryDetail | null>> = useCallback((update) => {
    const current = entryRef.current;
    const incoming = typeof update === 'function' ? update(current) : update;
    detailReadVersionRef.current++;
    if (!incoming) {
      entryRef.current = null;
      setEntry(null);
      return;
    }

    const safeLatestGeneration = isCurrentEntryGeneration(incoming, incoming.latestGeneration)
      ? incoming.latestGeneration
      : null;
    const safeLastSuccessfulGeneration =
      incoming.lastSuccessfulGeneration?.status === 'succeeded' &&
      incoming.lastSuccessfulGeneration.entryId === incoming.id &&
      incoming.lastSuccessfulGeneration.entryRevision <= incoming.revision
        ? incoming.lastSuccessfulGeneration
        : null;
    const safeIncoming = {
      ...incoming,
      latestGeneration: safeLatestGeneration,
      lastSuccessfulGeneration: safeLastSuccessfulGeneration,
    };
    let next: EntryDetail = safeIncoming;
    if (current?.id === safeIncoming.id) {
      if (safeIncoming.revision < current.revision) next = current;
      else {
        const merged = mergeEntryGenerationProgress(current, safeIncoming);
        const latestSuccess =
          merged.latestGeneration?.id === merged.latestGenerationId &&
          merged.latestGeneration.status === 'succeeded'
            ? merged.latestGeneration
            : null;
        const lastSuccessfulGeneration =
          latestSuccess ??
          safeLastSuccessfulGeneration ??
          (current.lastSuccessfulGeneration?.status === 'succeeded' &&
          current.lastSuccessfulGeneration.entryId === merged.id &&
          current.lastSuccessfulGeneration.entryRevision <= merged.revision
            ? current.lastSuccessfulGeneration
            : null);
        next = { ...merged, lastSuccessfulGeneration };
      }
    }
    entryRef.current = next;
    setEntry(next);
  }, []);
  const [error, setError] = useState('');
  const [pollingError, setPollingError] = useState('');
  const [foregroundActionFailed, setForegroundActionFailed] = useState(false);
  const displayError = error || pollingError;
  const [busy, setBusy] = useState(false);
  const [generationCaptchaOpen, setGenerationCaptchaOpen] = useState(false);
  const [generationCaptchaRetry, setGenerationCaptchaRetry] = useState(false);
  const [generationCaptchaAttempt, setGenerationCaptchaAttempt] = useState(0);
  const [generationRequestSending, setGenerationRequestSending] = useState(false);
  const [generationNavigation, setGenerationNavigation] =
    useState<DiaryActivity['generationNavigation']>(undefined);
  const [receiptUncertain, setReceiptUncertain] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [journalExpanded, setJournalExpanded] = useState(false);
  const activeRef = useRef(true);
  const editErrorRef = useRef<HTMLParagraphElement>(null);
  const actionInFlightRef = useRef(false);
  const generationFlowRef = useRef(false);
  const generationCaptchaAttemptRef = useRef(0);
  const generationRequestRef = useRef(false);
  const autoGenerationRequestedRef = useRef(
    Boolean(
      location.state &&
      typeof location.state === 'object' &&
      'startGeneration' in location.state &&
      location.state.startGeneration === true,
    ),
  );
  const { quota, activeGeneration, quotaState, refreshing, setActiveGeneration, refreshQuota } =
    useGenerationQuota({
      dataMode: config.dataMode,
      activeRef,
      markLoading: false,
      onActiveGeneration: (current) => {
        const existing = entryRef.current;
        if (current.entryId !== id || !existing || current.entryRevision !== existing.revision)
          return;
        if (
          existing.latestGenerationId &&
          existing.latestGenerationId !== current.id &&
          existing.latestGeneration &&
          current.entryRevision <= existing.latestGeneration.entryRevision
        )
          return;
        setEntrySafely((existing) =>
          existing
            ? {
                ...existing,
                latestGenerationId: current.id,
                latestGeneration: current,
                lastSuccessfulGeneration:
                  current.status === 'succeeded' ? current : existing.lastSuccessfulGeneration,
              }
            : existing,
        );
        if (current.status !== 'queued' && current.status !== 'running') setPollingError('');
      },
    });
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';
  const latestCandidate = entry?.latestGeneration;
  const pending = Boolean(
    entry &&
    latestCandidate &&
    latestCandidate.id === entry.latestGenerationId &&
    latestCandidate.entryId === entry.id &&
    latestCandidate.entryRevision <= entry.revision &&
    (latestCandidate.status === 'queued' || latestCandidate.status === 'running'),
  );
  const {
    editing,
    draftDate,
    setDraftDate,
    draftBody,
    setDraftBody,
    editErrorStatus,
    validationFailureCount,
    draftDirty,
    beginEditing,
    requestCancelEditing,
    saveEdit,
    requestReloadLatest,
    cancelEditing,
    reloadLatest,
    discardEditConfirmOpen,
    setDiscardEditConfirmOpen,
    reloadLatestConfirmOpen,
    setReloadLatestConfirmOpen,
  } = useEntryEditor({
    entry,
    setEntry: setEntrySafely,
    pending,
    busy,
    activeRef,
    actionInFlightRef,
    setBusy,
    setError,
    setOperationFailed: setForegroundActionFailed,
    readLatestEntry,
    onBeginEdit: () => {
      setGenerationNavigation(undefined);
      setDraftSavedEntryId(null);
      autoGenerationRequestedRef.current = false;
      if (generationFlowRef.current) {
        generationFlowRef.current = false;
        generationCaptchaAttemptRef.current += 1;
        setGenerationCaptchaOpen(false);
        setGenerationCaptchaRetry(false);
      }
    },
  });
  const openGenerationCaptcha = useCallback(
    (retry = false) => {
      if (generationFlowRef.current) return;
      setDraftSavedEntryId(null);
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

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      onActivityChange({ dirty: false, busy: false, failed: false });
    };
  }, [onActivityChange]);

  useLayoutEffect(() => {
    if (activeRef.current)
      onActivityChange({
        dirty: draftDirty,
        busy,
        failed: foregroundActionFailed,
        generationNavigation:
          generationNavigation?.entryId === id ? generationNavigation : undefined,
      });
  }, [busy, draftDirty, foregroundActionFailed, generationNavigation, id, onActivityChange]);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => void refreshQuota(), 0);
    return () => window.clearTimeout(refreshTimer);
  }, [refreshQuota]);

  useEffect(() => {
    let active = true;
    const readVersion = ++detailReadVersionRef.current;
    const guard = createDetailReadGuard(readVersion);
    loadLatestEntry(id, guard.isCurrent, 'initial')
      .then((result) => {
        if (active && result && guard.isCurrent()) setEntrySafely(result);
      })
      .catch((e: Error) => {
        if (active && guard.isCurrent()) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, setEntrySafely]);
  useEffect(() => {
    if (autoGenerationRequestedRef.current && location.state !== null)
      navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);
  useEffect(() => {
    if (!draftSavedNavigation || location.state === null) return;
    navigate(location.pathname, { replace: true, state: null });
  }, [draftSavedNavigation, location.pathname, location.state, navigate]);
  const generation =
    entry &&
    latestCandidate &&
    latestCandidate.id === entry.latestGenerationId &&
    latestCandidate.entryId === entry.id &&
    latestCandidate.entryRevision <= entry.revision
      ? latestCandidate
      : null;
  const generationForCurrentRevision = generation?.entryRevision === entry?.revision;
  const displayedGeneration =
    generation?.status === 'succeeded' && generation.entryRevision <= (entry?.revision ?? 0)
      ? generation
      : entry?.lastSuccessfulGeneration?.status === 'succeeded' &&
          entry.lastSuccessfulGeneration.entryId === entry.id &&
          entry.lastSuccessfulGeneration.entryRevision <= entry.revision
        ? entry.lastSuccessfulGeneration
        : null;
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
  const showQuotaStatus = Boolean(
    quota &&
    (quota.remainingToday === 0 || !quota.generationAvailable || quota.activeGenerationId !== null),
  );
  const comicFromPreviousRevision = Boolean(
    displayedGeneration && displayedGeneration.entryRevision < (entry?.revision ?? 0),
  );
  const showGenerationAction = Boolean(
    !pending &&
    !unknownGeneration &&
    !generationReferenceUnavailable &&
    !generationForCurrentRevision &&
    !hasUnresolvedRequest,
  );
  const showExternalAiPolicy =
    config.dataMode === 'live' &&
    ((showGenerationAction && canStartGeneration) ||
      generationCaptchaOpen ||
      generationCaptchaRetry);
  const draftSavedConfirmation = Boolean(
    entry && draftSavedEntryId === id && !generation && !generationReferenceUnavailable && !editing,
  );
  const editFormVisible = Boolean(entry && editing);
  const statusKind: 'queued' | 'running' | 'unknown' | 'failed' | 'cancelled' | null =
    generation?.status === 'queued'
      ? 'queued'
      : generation?.status === 'running'
        ? 'running'
        : generation?.status === 'unknown' || generationReferenceUnavailable
          ? 'unknown'
          : generation?.status === 'failed'
            ? 'failed'
            : generation?.status === 'cancelled'
              ? 'cancelled'
              : null;
  const statusTitle =
    statusKind === 'queued' || statusKind === 'running'
      ? generationForCurrentRevision
        ? '漫画をつくっています'
        : '編集前の生成を処理しています'
      : statusKind === 'unknown'
        ? !generation || generationForCurrentRevision
          ? '生成結果を確認中'
          : '編集前の生成結果を確認中'
        : statusKind === 'failed'
          ? generationForCurrentRevision
            ? '漫画を生成できませんでした'
            : '編集前の生成に失敗しました'
          : statusKind === 'cancelled'
            ? generationForCurrentRevision
              ? '生成を終了しました'
              : '編集前の生成を終了しました'
            : '';
  const statusView = Boolean(statusKind && !editing);
  const detailPageClass = [
    'detail-page',
    statusView && 'is-status',
    statusView && statusKind && `is-${statusKind}`,
    statusView && displayedGeneration && 'has-saved-comic',
    !statusView &&
      (draftSavedConfirmation ||
        (displayedGeneration?.id === generation?.id && generationForCurrentRevision)) &&
      'is-saved',
    !statusView &&
      !draftSavedConfirmation &&
      !(displayedGeneration?.id === generation?.id && generationForCurrentRevision) &&
      'is-draft',
  ]
    .filter(Boolean)
    .join(' ');
  const savedDiaryCharacters = entry ? Array.from(entry.body) : [];
  const savedDiaryHasMore = savedDiaryCharacters.length > 120;
  const savedDiaryPreview = savedDiaryHasMore
    ? `${savedDiaryCharacters.slice(0, 120).join('')}…`
    : savedDiaryCharacters.join('');
  useEffect(() => {
    if (!displayError || !editFormVisible) return;
    const alert = editErrorRef.current;
    alert?.focus({ preventScroll: true });
    alert?.scrollIntoView({ block: 'center' });
  }, [displayError, editFormVisible, validationFailureCount]);

  function createDetailReadGuard(readVersion = detailReadVersionRef.current) {
    const startingEntry = entryRef.current;
    const isReadCurrent = () => {
      const current = entryRef.current;
      return (
        activeRef.current &&
        readVersion === detailReadVersionRef.current &&
        (!startingEntry ||
          !current ||
          (current.id === startingEntry.id &&
            current.revision === startingEntry.revision &&
            current.latestGenerationId === startingEntry.latestGenerationId))
      );
    };
    const currentEntryAfterStaleRead = () => {
      const current = entryRef.current;
      if (current) return current;
      throw new Error('記録の状態が更新されています。最新の状態を読み直してください。');
    };
    return { isCurrent: isReadCurrent, currentEntryAfterStaleRead };
  }

  async function loadLatestEntry(
    entryId: string,
    isReadCurrent: () => boolean,
    mode: 'initial' | 'foreground',
  ): Promise<EntryDetail | null> {
    const result = await getEntry(entryId);
    if (!isReadCurrent() || result.id !== entryId) return null;
    const latest = await completeEntryDetail(result, getGeneration, mode);
    if (!isReadCurrent()) return null;
    if (
      latest.latestGeneration &&
      latest.latestGeneration.status !== 'queued' &&
      latest.latestGeneration.status !== 'running'
    )
      setPollingError('');
    return latest;
  }

  async function readLatestEntry(): Promise<EntryDetail> {
    const guard = createDetailReadGuard();
    let latest: EntryDetail | null;
    try {
      latest = await loadLatestEntry(id, guard.isCurrent, 'foreground');
    } catch (failure) {
      if (!guard.isCurrent()) return guard.currentEntryAfterStaleRead();
      throw failure;
    }
    if (!latest || !guard.isCurrent()) return guard.currentEntryAfterStaleRead();
    setEntrySafely(latest);
    return entryRef.current ?? latest;
  }

  function applyGeneration(currentGeneration: Generation) {
    const current = entryRef.current;
    if (!current) return;
    if (
      currentGeneration.entryId !== current.id ||
      currentGeneration.entryRevision > current.revision ||
      current.latestGenerationId !== currentGeneration.id
    )
      return;
    const updated = {
      ...current,
      latestGenerationId: currentGeneration.id,
      latestGeneration: currentGeneration,
      lastSuccessfulGeneration:
        currentGeneration.status === 'succeeded'
          ? currentGeneration
          : current.lastSuccessfulGeneration,
    };
    setActiveGeneration(currentGeneration);
    setEntrySafely(updated);
  }

  async function receiveGenerationReceipt(receipt: Awaited<ReturnType<typeof generate>>) {
    if (!activeRef.current) return;
    setGenerationNavigation({ stage: 'accepted', entryId: id ?? null });
    setGenerationCaptchaOpen(false);
    try {
      const latest = await readLatestEntry();
      if (!activeRef.current) return;
      if (latest.latestGenerationId === receipt.generationId && latest.latestGeneration)
        applyGeneration(latest.latestGeneration);
      setReceiptUncertain(false);
      setGenerationCaptchaRetry(false);
      setForegroundActionFailed(false);
      setError('');
      await refreshQuota({ fresh: true });
    } catch {
      if (!activeRef.current) return;
      setReceiptUncertain(true);
      setForegroundActionFailed(true);
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

  async function handleGenerationFailure(failure: unknown, fallback: string) {
    const apiFailure = failure instanceof ApiClientError ? failure : null;
    setForegroundActionFailed(true);
    setError(generationActionErrorMessage(failure, fallback));
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
      await refreshQuota({ fresh: true });
    if (
      apiFailure?.code === 'ENTRY_BUSY' ||
      apiFailure?.code === 'IDEMPOTENCY_CONFLICT' ||
      apiFailure?.code === 'REVISION_CONFLICT' ||
      apiFailure?.code === 'REVISION_ALREADY_GENERATED'
    ) {
      const latest = await readLatestEntry().catch(() => null);
      if (activeRef.current && latest) {
        const status = latest.latestGeneration?.status;
        if (
          apiFailure.code === 'REVISION_ALREADY_GENERATED' &&
          status === 'succeeded' &&
          latest.latestGeneration?.entryRevision === latest.revision
        ) {
          setReceiptUncertain(false);
          setGenerationCaptchaRetry(false);
          setError('');
          setForegroundActionFailed(false);
          await refreshQuota({ fresh: true });
        } else if (status === 'queued' || status === 'running') {
          setReceiptUncertain(false);
          setGenerationCaptchaRetry(false);
          setError('');
          setForegroundActionFailed(false);
        }
      }
    }
  }

  async function submitGeneration(captchaToken = '') {
    if (!entry || !activeRef.current || generationRequestRef.current || actionInFlightRef.current)
      return;
    if (config.dataMode === 'live' && !captchaToken) {
      openGenerationCaptcha();
      return;
    }
    generationRequestRef.current = true;
    setGenerationNavigation({ stage: 'requesting', entryId: entry.id });
    generationFlowRef.current = true;
    actionInFlightRef.current = true;
    setDraftSavedEntryId(null);
    setGenerationCaptchaOpen(false);
    setGenerationRequestSending(true);
    setBusy(true);
    setForegroundActionFailed(false);
    setPollingError('');
    setError('');
    try {
      const receipt = await generate(entry, captchaToken);
      if (!activeRef.current) return;
      await receiveGenerationReceipt(receipt);
    } catch (failure) {
      if (!activeRef.current) return;
      await handleGenerationFailure(failure, '漫画の受付を確認できませんでした。');
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
    setGenerationNavigation({ stage: 'requesting', entryId: entry.id });
    actionInFlightRef.current = true;
    setBusy(true);
    setForegroundActionFailed(false);
    setPollingError('');
    setError('');
    try {
      const receipt = await recheckGeneration(entry);
      if (!activeRef.current) return;
      await receiveGenerationReceipt(receipt);
    } catch (failure) {
      if (!activeRef.current) return;
      await handleGenerationFailure(failure, '受付結果を確認できませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function refreshGenerationStatus() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    setGenerationNavigation(undefined);
    actionInFlightRef.current = true;
    setBusy(true);
    setForegroundActionFailed(false);
    setPollingError('');
    setError('');
    try {
      const latest = await readLatestEntry();
      if (!activeRef.current) return;
      setDraftDate(latest.diaryDate);
      setDraftBody(latest.body);
      setReceiptUncertain(false);
      await refreshQuota({ fresh: true });
    } catch (failure) {
      if (activeRef.current) {
        setForegroundActionFailed(true);
        setError(failure instanceof Error ? failure.message : '最新の状態を読み込めませんでした。');
      }
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  function showOriginalDiary() {
    setJournalExpanded(true);
    window.requestAnimationFrame(() =>
      document.getElementById('original-diary')?.scrollIntoView({ block: 'center' }),
    );
  }

  useGenerationPolling(generation, activeRef, applyGeneration, setPollingError, refreshQuota);

  async function removeEntry() {
    if (!entry || !activeRef.current || actionInFlightRef.current) return;
    setGenerationNavigation(undefined);
    actionInFlightRef.current = true;
    setBusy(true);
    setForegroundActionFailed(false);
    setError('');
    try {
      await api(`/entries/${entry.id}`, { method: 'DELETE' });
      if (!activeRef.current) return;
      setForegroundActionFailed(false);
      onActivityChange({ dirty: false, busy: false, failed: false });
      if (!hasBlockedNavigation()) navigate(backTo);
    } catch (failure) {
      if (activeRef.current) {
        setForegroundActionFailed(true);
        setError(failure instanceof Error ? failure.message : '操作できませんでした。');
      }
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className={detailPageClass}>
      {entry && !editing && (
        <DetailToolbar
          backTo={backTo}
          title={
            statusView
              ? statusTitle
              : generation?.status === 'succeeded' && generationForCurrentRevision
                ? generation.comic.title
                : summarizeDiary(entry.body)
          }
          summary={summarizeDiary(entry.body)}
          statusView={statusView}
          pending={pending}
          busy={busy}
          onEdit={beginEditing}
          onDelete={() => setDeleteConfirmOpen(true)}
        />
      )}
      {entry && editing && (
        <header className="detail-edit-toolbar">
          <button
            className="icon-button"
            type="button"
            aria-label="編集をやめる"
            disabled={busy}
            onClick={requestCancelEditing}
          >
            <Icon name="back" />
          </button>
          <h1>日記を編集</h1>
          <button
            className="button-text"
            type="submit"
            form="edit-entry-form"
            disabled={busy || pending || !draftDirty}
          >
            {busy ? '保存中' : '保存'}
          </button>
        </header>
      )}
      {entry ? (
        <>
          {!editing && (!statusView || displayedGeneration) && !draftSavedConfirmation && (
            <div className="detail-date-row">
              <time dateTime={entry.diaryDate}>{formatDiaryDate(entry.diaryDate)}</time>
            </div>
          )}
          {!editing && draftSavedConfirmation && (
            <time className="detail-draft-saved-date" dateTime={entry.diaryDate}>
              {formatDiaryDate(entry.diaryDate)}
            </time>
          )}
          {comicFromPreviousRevision && !statusView && (
            <p className="detail-revision-note">編集前の日記から生成された漫画です。</p>
          )}

          {editing ? (
            <form
              id="edit-entry-form"
              className="entry-form detail-edit-form"
              onSubmit={(event) => void saveEdit(event)}
            >
              <fieldset disabled={busy || pending} className="entry-form-fields">
                {pending && (
                  <output className="detail-edit-pending-note">
                    この記録は生成中のため変更を保存できません。入力内容は保持され、生成が完了すると編集を再開できます。
                  </output>
                )}
                <div className="date-row">
                  <DiaryDateField id="edit-date" value={draftDate} onChange={setDraftDate} />
                </div>
                <DiaryBodyField
                  id="edit-body"
                  countId="edit-count"
                  value={draftBody}
                  onChange={setDraftBody}
                  placeholder="今日はどんな日だった？"
                />
              </fieldset>
              {editErrorStatus === 409 && (
                <button
                  className="button button-secondary latest-entry-action"
                  disabled={busy || pending}
                  type="button"
                  onClick={requestReloadLatest}
                >
                  最新の記録を読み込む
                </button>
              )}
              {displayError && (
                <p ref={editErrorRef} role="alert" tabIndex={-1} className="error">
                  {displayError}
                </p>
              )}
            </form>
          ) : (
            <>
              {draftSavedConfirmation && (
                <section className="draft-saved-card" aria-labelledby="draft-saved-title">
                  <div className="draft-saved-check" aria-hidden="true">
                    <Icon name="check" size={40} />
                  </div>
                  <h2 id="draft-saved-title">日記を保存しました</h2>
                  <p className="diary">{savedDiaryPreview}</p>
                  {savedDiaryHasMore && (
                    <details className="original-diary draft-saved-original">
                      <summary>日記の全文を読む</summary>
                      <p className="diary">{entry.body}</p>
                    </details>
                  )}
                  {canStartGeneration && <p>続けて4コマにできます。</p>}
                </section>
              )}
              {displayedGeneration && (
                <SavedComic
                  key={displayedGeneration.id}
                  comic={displayedGeneration.comic}
                  hideTitle={displayedGeneration.entryRevision === entry.revision}
                />
              )}
              <GenerationStatusCard
                generation={generation}
                referenceUnavailable={generationReferenceUnavailable}
                isCurrentRevision={generationForCurrentRevision}
              />
              {!generation &&
                !displayedGeneration &&
                !generationReferenceUnavailable &&
                !draftSavedConfirmation && (
                  <>
                    <section className="entry-draft-card">
                      <p className="diary">{entry.body}</p>
                    </section>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={beginEditing}
                    >
                      <Icon name="edit" size={18} />
                      日記を編集
                    </button>
                  </>
                )}
              {(generation || displayedGeneration) && !pending && !unknownGeneration && (
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
        !displayError && <output>読み込んでいます…</output>
      )}
      {displayError && !editFormVisible && (
        <p role="alert" className="error">
          {displayError}
        </p>
      )}
      {entry && !editing && (
        <>
          {statusView && !displayedGeneration && (
            <aside className="detail-meta-note">
              <div className="detail-date-row">
                <time dateTime={entry.diaryDate}>{formatDiaryDate(entry.diaryDate)}</time>
              </div>
            </aside>
          )}
          {comicFromPreviousRevision && statusView && (
            <p className="detail-revision-note">編集前の日記から生成された漫画です。</p>
          )}
          {quota && !pending && !unknownGeneration && (
            <div className={showQuotaStatus ? 'detail-quota-card' : 'sr-only'}>
              <GenerationQuotaStatus
                quota={quota}
                activeGeneration={activeGeneration}
                currentEntryId={entry.id}
                currentGenerationId={generation?.id ?? entry.latestGenerationId}
                onRefresh={showQuotaStatus ? () => void refreshQuota() : undefined}
                refreshing={refreshing}
              />
            </div>
          )}
          {(quotaState === 'session-required' || quotaState === 'unavailable') &&
            !pending &&
            !unknownGeneration && (
              <div className="inline-alert" role="alert">
                <p>
                  {quotaState === 'session-required'
                    ? '保存済みの匿名セッションを確認できないため、漫画の受付を停止しています。別の匿名アカウントは自動で作成しません。'
                    : '利用枠を確認できないため、漫画の受付を停止しています。日記の閲覧と保存は続けられます。'}
                </p>
                <button
                  className="button-text"
                  type="button"
                  disabled={refreshing}
                  onClick={() => void refreshQuota()}
                >
                  {refreshing ? '利用枠を確認しています…' : '利用枠を再確認'}
                </button>
              </div>
            )}
        </>
      )}
      {entry && editing && quota && (
        <div className="sr-only">
          <GenerationQuotaStatus
            quota={quota}
            activeGeneration={activeGeneration}
            currentEntryId={entry.id}
            currentGenerationId={generation?.id ?? entry.latestGenerationId}
          />
        </div>
      )}
      {entry && editing && (quotaState === 'session-required' || quotaState === 'unavailable') && (
        <div className="inline-alert" role="alert">
          <p>
            {quotaState === 'session-required'
              ? '保存済みの匿名セッションを確認できないため、漫画の受付を停止しています。別の匿名アカウントは自動で作成しません。'
              : '利用枠を確認できないため、漫画の受付を停止しています。日記の閲覧と保存は続けられます。'}
          </p>
          <button
            className="button-text"
            type="button"
            disabled={refreshing}
            onClick={() => void refreshQuota()}
          >
            {refreshing ? '利用枠を確認しています…' : '利用枠を再確認'}
          </button>
        </div>
      )}
      {entry && !editing && (
        <div className="primary-action-dock detail-action-dock">
          {showExternalAiPolicy && (
            <p className="policy-note">※漫画の生成時に、日記の内容を外部AIへ送信します。</p>
          )}
          {quota && !showQuotaStatus && !pending && !unknownGeneration && (
            <button
              className="button-text quota-refresh-action"
              disabled={busy || refreshing}
              type="button"
              onClick={() => void refreshQuota()}
            >
              {refreshing ? '利用枠を確認しています…' : '利用枠を再確認'}
            </button>
          )}
          {pending && (
            <Link className="button button-primary" to={backTo}>
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
          {generation?.status === 'failed' && generationForCurrentRevision && (
            <button className="button button-primary" type="button" onClick={showOriginalDiary}>
              保存した日記を見る
            </button>
          )}
          {generation?.status === 'cancelled' && generationForCurrentRevision && (
            <button className="button button-primary" type="button" onClick={showOriginalDiary}>
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
                      : quota?.remainingToday === 0
                        ? '本日の生成上限に達しています'
                        : quota?.generationAvailable === false
                          ? '漫画の受付を停止しています'
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
        icon={null}
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
        icon={null}
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
  hasBlockedNavigation,
}: {
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
  hasBlockedNavigation: () => boolean;
}) {
  const { id = '' } = useParams();
  return (
    <DetailContent
      key={id}
      id={id}
      config={config}
      onActivityChange={onActivityChange}
      hasBlockedNavigation={hasBlockedNavigation}
    />
  );
}
