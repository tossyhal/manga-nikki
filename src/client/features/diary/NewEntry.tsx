import { useGenerationQuota, quotaAllowsGeneration } from './useGenerationQuota';
import { DiaryDateField } from './DiaryDateField';
import { DiaryBodyField } from './DiaryBodyField';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { createEntrySchema, type Entry } from '../../../shared/schemas';
import { jstToday } from '../../../shared/date';
import { summarizeDiary } from '../../../shared/summary';
import { RegistrationCaptcha } from './RegistrationCaptcha';
import { GenerationQuotaStatus } from './GenerationQuotaStatus';
import { ApiClientError, createEntry, generate, recheckGeneration } from '../../lib/api';
import { registerAnonymousSession, getLiveAccessToken } from '../../lib/auth';
import type { ClientConfig } from '../../lib/config';
import { Icon } from '../../app/Icon';
import { useOnlineStatus } from '../../lib/useOnlineStatus';

import type { DiaryActivity } from './diaryActivity';

type NewEntryProps = {
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
};

export function NewEntry({ config, onActivityChange }: NewEntryProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const requestId = useRef(crypto.randomUUID());
  const activeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const saveErrorCardRef = useRef<HTMLElement | null>(null);
  const { online, refreshOnlineStatus } = useOnlineStatus();
  const previousOnlineRef = useRef(online);
  const [initialDate] = useState(() => {
    const today = jstToday();
    const requestedDate = new URLSearchParams(location.search).get('date');
    if (!requestedDate || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return today;
    const parsedDate = new Date(`${requestedDate}T00:00:00.000Z`);
    if (
      Number.isNaN(parsedDate.valueOf()) ||
      parsedDate.toISOString().slice(0, 10) !== requestedDate
    )
      return today;
    return requestedDate <= today ? requestedDate : today;
  });
  const [saved, setSaved] = useState<Entry | null>(null);
  const [date, setDate] = useState(initialDate);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [validationFailureCount, setValidationFailureCount] = useState(0);
  const [saveErrorIntent, setSaveErrorIntent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSave, setPendingSave] = useState<boolean | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [generationCheckEntry, setGenerationCheckEntry] = useState<Entry | null>(null);
  const [generationFailureEntry, setGenerationFailureEntry] = useState<Entry | null>(null);
  const { quota, activeGeneration, quotaState, refreshing, setQuotaState, refreshQuota } =
    useGenerationQuota({
      dataMode: config.dataMode,
      activeRef,
      markLoading: true,
    });
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';
  const configAllowsGeneration = config.dataMode !== 'sample' && config.generationAvailable;
  const sessionRequired = config.dataMode === 'live' && quotaState === 'session-required';
  const canGenerate =
    online &&
    configAllowsGeneration &&
    (sessionRequired || (quotaState === 'ready' && quotaAllowsGeneration(quota)));
  const quotaLimited = Boolean(
    config.dataMode !== 'sample' &&
    (!config.generationAvailable ||
      (quota &&
        (quota.remainingToday === 0 ||
          !quota.generationAvailable ||
          quota.activeGenerationId !== null))),
  );
  const showQuotaStatus = Boolean(
    quota &&
    (quota.remainingToday === 0 || !quota.generationAvailable || quota.activeGenerationId !== null),
  );
  const dirty = saved === null && (body.length > 0 || date !== initialDate);

  useLayoutEffect(() => {
    if (activeRef.current) onActivityChange({ dirty, busy });
  }, [busy, dirty, onActivityChange]);

  useEffect(() => {
    activeRef.current = true;
    const refreshTimer = window.setTimeout(() => {
      if (navigator.onLine) void refreshQuota();
    }, 0);
    return () => {
      window.clearTimeout(refreshTimer);
      activeRef.current = false;
      onActivityChange({ dirty: false, busy: false });
    };
  }, [onActivityChange, refreshQuota]);

  useEffect(() => {
    if (previousOnlineRef.current === online) return;
    previousOnlineRef.current = online;
    if (!online) return;
    const refreshTimer = window.setTimeout(() => void refreshQuota(), 0);
    return () => window.clearTimeout(refreshTimer);
  }, [online, refreshQuota]);

  useEffect(() => {
    if (!error) return;
    const alert = saveErrorCardRef.current ?? errorRef.current;
    alert?.focus({ preventScroll: true });
    alert?.scrollIntoView({ block: 'center' });
  }, [error, saveErrorIntent, validationFailureCount]);

  function showValidationError(message: string) {
    setValidationFailureCount((count) => count + 1);
    setError(message);
  }

  async function persist(makeComic: boolean, registrationToken?: string) {
    if (!navigator.onLine) {
      refreshOnlineStatus();
      setError('オフラインのため保存できません。入力内容はこの画面に残っています。');
      return;
    }
    const parsed = createEntrySchema.safeParse({
      createRequestId: requestId.current,
      diaryDate: date,
      body,
      consentVersion: config.consentVersion,
    });
    if (!parsed.success) {
      showValidationError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      return;
    }
    if (registrationToken) {
      await registerAnonymousSession(registrationToken);
      if (!activeRef.current) return;
    }
    let entry = saved;
    if (!entry) {
      try {
        entry = await createEntry(parsed.data);
      } catch (failure) {
        if (activeRef.current) setSaveErrorIntent(makeComic);
        throw failure;
      }
      if (!activeRef.current) return;
      setSaved(entry);
      onActivityChange({ dirty: false, busy: makeComic && config.dataMode === 'mock' });
    }
    if (!makeComic) {
      onActivityChange({ dirty: false, busy: false });
      navigate(`/entries/${encodeURIComponent(entry.id)}`, { state: { draftSaved: true } });
      return;
    }
    if (!navigator.onLine) {
      refreshOnlineStatus();
      setError('日記は保存しました。オフラインのため漫画の受付はしていません。');
      onActivityChange({ dirty: false, busy: false });
      navigate(`/entries/${encodeURIComponent(entry.id)}`, { state: { draftSaved: true } });
      return;
    }
    if (makeComic && config.dataMode === 'mock') {
      const currentQuota = await refreshQuota();
      if (!activeRef.current) return;
      if (!quotaAllowsGeneration(currentQuota)) {
        setError(
          currentQuota?.activeGenerationId
            ? '別の漫画を作成しています。先に進行中の記録を確認してください。'
            : currentQuota?.remainingToday === 0
              ? '本日の生成上限に達しています。日記は保存しました。'
              : '利用枠を確認できないため、漫画の受付を停止しています。日記は保存しました。',
        );
        onActivityChange({ dirty: false, busy: false });
        navigate(`/entries/${encodeURIComponent(entry.id)}`, { state: { draftSaved: true } });
        return;
      }
      try {
        await generate(entry);
      } catch (failure) {
        if (activeRef.current) setGenerationFailureEntry(entry);
        if (
          activeRef.current &&
          failure instanceof ApiClientError &&
          failure.status === null &&
          failure.code === null
        ) {
          setGenerationCheckEntry(entry);
        }
        throw failure;
      }
    }
    if (!activeRef.current) return;
    onActivityChange({ dirty: false, busy: false });
    navigate(`/entries/${entry.id}`, {
      state: makeComic && config.dataMode === 'live' ? { startGeneration: true } : null,
    });
  }

  async function save(makeComic: boolean) {
    if (!activeRef.current || actionInFlightRef.current) return;
    if (!navigator.onLine) {
      refreshOnlineStatus();
      setError('オフラインのため保存できません。入力内容はこの画面に残っています。');
      return;
    }
    const parsed = createEntrySchema.safeParse({
      createRequestId: requestId.current,
      diaryDate: date,
      body,
      consentVersion: config.consentVersion,
    });
    if (!parsed.success) {
      showValidationError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      return;
    }
    setSaveErrorIntent(null);
    setError('');
    actionInFlightRef.current = true;
    setBusy(true);
    try {
      if (config.dataMode === 'live') {
        const accessToken = await getLiveAccessToken();
        if (!activeRef.current) return;
        if (!accessToken) {
          if (!siteKey) {
            throw new Error(
              '匿名登録用の確認を利用できません。入力した本文はこの画面に残っています。',
            );
          }
          setPendingSave(makeComic);
          setCaptchaAttempt((attempt) => attempt + 1);
          return;
        }
      }
      await persist(makeComic);
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '保存できませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function completeRegistration(captchaToken: string) {
    if (!activeRef.current || actionInFlightRef.current) return;
    const makeComic = pendingSave;
    setPendingSave(null);
    if (makeComic === null) return;
    if (!navigator.onLine) {
      refreshOnlineStatus();
      setError('オフラインのため保存できません。入力内容はこの画面に残っています。');
      return;
    }
    if (!captchaToken) {
      showValidationError('匿名登録には新しい確認が必要です。');
      return;
    }
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      await persist(makeComic, captchaToken);
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '保存できませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function checkGenerationReceipt() {
    if (!generationCheckEntry || !activeRef.current || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      await recheckGeneration(generationCheckEntry);
      if (activeRef.current) {
        onActivityChange({ dirty: false, busy: false });
        navigate(`/entries/${generationCheckEntry.id}`);
      }
    } catch (failure) {
      if (activeRef.current)
        setError(failure instanceof Error ? failure.message : '受付結果を確認できませんでした。');
    } finally {
      if (activeRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  function failRegistrationCaptcha() {
    setPendingSave(null);
    setError('確認に失敗しました。本文は残っています。新しい確認を取得して再操作してください。');
  }

  const primaryDisabled =
    busy || saved !== null || !online || (quotaState === 'loading' && configAllowsGeneration);
  const pageClasses = [
    'new-entry-page',
    !online && 'is-offline',
    online && (quotaLimited || quotaState === 'unavailable') && 'is-limited',
    saveErrorIntent !== null && 'has-save-error',
  ]
    .filter(Boolean)
    .join(' ');

  function recheckConnection() {
    const current = refreshOnlineStatus();
    if (current && online) {
      setQuotaState('loading');
      void refreshQuota();
    }
  }

  return (
    <section className={pageClasses}>
      <form
        className="entry-form new-entry-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(saveErrorIntent ?? canGenerate);
        }}
      >
        <h1 className="sr-only">日記を書く</h1>
        <fieldset disabled={busy || saved !== null} className="entry-form-fields">
          <div className="date-row">
            <DiaryDateField id="date" value={date} onChange={setDate} />
            <button
              className="button-text"
              disabled={busy || saved !== null || !online}
              type="button"
              onClick={() => void save(false)}
            >
              下書き保存
            </button>
          </div>
          <DiaryBodyField
            id="body"
            countId="count"
            value={body}
            onChange={setBody}
            placeholder="今日のできごとを書いてみよう。"
            descriptionId="summary-preview"
            footer={
              <p id="summary-preview" className="summary-preview sr-only">
                {body.trim() ? `見出し：${summarizeDiary(body)}` : '見出しは本文から自動で作ります'}
              </p>
            }
          />
        </fieldset>
        {online &&
          quota &&
          (showQuotaStatus ? (
            <div className="quota-limit-card">
              <GenerationQuotaStatus
                quota={quota}
                activeGeneration={activeGeneration}
                currentGenerationId={null}
                onRefresh={() => void refreshQuota()}
                refreshing={refreshing}
              />
            </div>
          ) : (
            <div className="sr-only">
              <GenerationQuotaStatus
                quota={quota}
                activeGeneration={activeGeneration}
                currentGenerationId={null}
              />
            </div>
          ))}
        {online &&
          !config.generationAvailable &&
          config.dataMode !== 'sample' &&
          quotaState !== 'unavailable' &&
          quota?.generationAvailable !== false && (
            <section className="quota-limit-card" aria-label="漫画の利用状況">
              <p>現在、漫画の受付を停止しています。日記は保存できます。</p>
            </section>
          )}
        {quotaState === 'unavailable' && online && (
          <section className="quota-limit-card" aria-label="漫画の利用状況">
            <p role="alert">
              利用枠を確認できないため、漫画の受付を停止しています。日記の保存は引き続きできます。
            </p>
            <button
              className="button-text"
              disabled={busy || refreshing}
              type="button"
              onClick={() => {
                setQuotaState('loading');
                void refreshQuota();
              }}
            >
              {refreshing ? '利用枠を確認しています…' : '利用枠を再確認'}
            </button>
          </section>
        )}
        {!online && (
          <>
            <section className="offline-entry-card" aria-labelledby="offline-entry-title">
              <Icon name="wifi-off" size={28} />
              <div>
                <h2 id="offline-entry-title">オフラインです</h2>
                <p>入力内容はこの画面に残っています。接続が戻ってから保存してください。</p>
              </div>
            </section>
            <button
              className="button button-primary offline-recheck-action"
              type="button"
              onClick={recheckConnection}
            >
              接続を再確認する
            </button>
          </>
        )}
        {pendingSave !== null && config.dataMode === 'live' && (
          <section className="captcha-card" aria-label="匿名登録">
            <p>匿名登録を続けるため、登録用の確認を行います。</p>
            {siteKey ? (
              <RegistrationCaptcha
                key={captchaAttempt}
                siteKey={siteKey}
                requestKey={captchaAttempt}
                onToken={(token) => void completeRegistration(token)}
                onError={failRegistrationCaptcha}
              />
            ) : (
              <p role="alert" className="error">
                匿名登録用の確認を利用できません。本文はこの画面に残っています。
              </p>
            )}
          </section>
        )}
        {saveErrorIntent !== null ? (
          <section
            ref={saveErrorCardRef}
            className="save-error-card"
            aria-labelledby="save-error-title"
            role="alert"
            tabIndex={-1}
          >
            <Icon name="alert" size={22} />
            <div>
              <h2 id="save-error-title">保存できませんでした</h2>
              <p>{error}</p>
              <p>本文は消えていません。</p>
            </div>
          </section>
        ) : error ? (
          <p ref={errorRef} role="alert" className="error" tabIndex={-1}>
            {error}
          </p>
        ) : null}
        {generationFailureEntry && (
          <section className="draft-saved-card" aria-labelledby="generation-failure-saved-title">
            <div className="draft-saved-check" aria-hidden="true">
              <Icon name="check" size={40} />
            </div>
            <h2 id="generation-failure-saved-title">日記を保存しました</h2>
            <p>漫画の受付状態は、保存した記録から確認できます。</p>
            <Link
              className="button button-secondary"
              to={`/entries/${encodeURIComponent(generationFailureEntry.id)}`}
            >
              保存した記録を見る
            </Link>
          </section>
        )}
        {generationCheckEntry && (
          <button
            className="button button-secondary"
            disabled={busy}
            type="button"
            onClick={() => void checkGenerationReceipt()}
          >
            {busy ? '受付結果を確認しています…' : '受付結果を確認'}
          </button>
        )}
        {!online ? null : (
          <>
            {import.meta.env.PROD && config.dataMode === 'live' && canGenerate && (
              <p className="policy-note">※漫画の生成時に、日記の内容を外部AIへ送信します。</p>
            )}
            <div className="primary-action-dock">
              <div className="primary-action-row">
                <button className="button button-primary" disabled={primaryDisabled} type="submit">
                  {busy
                    ? '保存しています…'
                    : saveErrorIntent !== null
                      ? 'もう一度保存'
                      : canGenerate
                        ? '4コマにする'
                        : quotaState === 'loading' && configAllowsGeneration
                          ? '利用枠を確認しています…'
                          : '下書きとして保存'}
                </button>
                {quota && !showQuotaStatus && (
                  <button
                    className="button-text quota-refresh-action"
                    disabled={busy || refreshing}
                    type="button"
                    onClick={() => void refreshQuota()}
                  >
                    {refreshing ? '確認中…' : '枠を更新'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </form>
    </section>
  );
}
