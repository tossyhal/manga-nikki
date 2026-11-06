import {
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type FormEvent,
} from 'react';
import { updateEntrySchema, type Entry, type EntryDetail } from '../../../shared/schemas';
import { api, ApiClientError } from '../../lib/api';

export function useEntryEditor({
  entry,
  setEntry,
  pending,
  busy,
  activeRef,
  actionInFlightRef,
  setBusy,
  setError,
  setOperationFailed,
  readLatestEntry,
  onBeginEdit,
}: {
  entry: EntryDetail | null;
  setEntry: Dispatch<SetStateAction<EntryDetail | null>>;
  pending: boolean;
  busy: boolean;
  activeRef: RefObject<boolean>;
  actionInFlightRef: RefObject<boolean>;
  setBusy: (busy: boolean) => void;
  setError: (message: string) => void;
  setOperationFailed: (failed: boolean) => void;
  readLatestEntry: () => Promise<EntryDetail>;
  onBeginEdit: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [editErrorStatus, setEditErrorStatus] = useState<number | null>(null);
  const [validationFailureCount, setValidationFailureCount] = useState(0);
  const [discardEditConfirmOpen, setDiscardEditConfirmOpen] = useState(false);
  const [reloadLatestConfirmOpen, setReloadLatestConfirmOpen] = useState(false);
  const draftDirty =
    editing && entry !== null && (draftDate !== entry.diaryDate || draftBody !== entry.body);
  function beginEditing() {
    if (!entry || pending || busy || actionInFlightRef.current) return;
    onBeginEdit();
    setDraftDate(entry.diaryDate);
    setDraftBody(entry.body);
    setEditErrorStatus(null);
    setError('');
    setOperationFailed(false);
    setEditing(true);
  }

  function cancelEditing() {
    if (!entry) return;
    setDraftDate(entry.diaryDate);
    setDraftBody(entry.body);
    setEditErrorStatus(null);
    setError('');
    setOperationFailed(false);
    setEditing(false);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entry || pending || !activeRef.current || actionInFlightRef.current) return;
    setOperationFailed(false);
    const parsed = updateEntrySchema.safeParse({
      expectedRevision: entry.revision,
      diaryDate: draftDate,
      body: draftBody,
    });
    if (!parsed.success) {
      setValidationFailureCount((count) => count + 1);
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
        setOperationFailed(true);
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
    setOperationFailed(false);
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
    if (busy || actionInFlightRef.current) return;
    if (!draftDirty) {
      cancelEditing();
      return;
    }
    setDiscardEditConfirmOpen(true);
  }

  return {
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
  };
}
