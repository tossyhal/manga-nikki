import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { createEntrySchema, jstToday, type Entry, type Generation } from '../../../shared/schemas';
import { RegistrationCaptcha } from './RegistrationCaptcha';
import { GenerationQuotaStatus } from './GenerationQuotaStatus';
import {
  ApiClientError,
  api,
  generate,
  getGeneration,
  getQuotaForExistingSession,
  recheckGeneration,
  type GenerationQuota,
} from '../../lib/api';
import { registerAnonymousSession, getLiveAccessToken } from '../../lib/auth';
import type { ClientConfig } from '../../lib/config';

export type DiaryActivity = { dirty: boolean; busy: boolean };

type NewEntryProps = {
  config: ClientConfig;
  onActivityChange: (activity: DiaryActivity) => void;
};

type QuotaState = 'loading' | 'ready' | 'session-required' | 'unavailable';

function generationIsAvailable(quota: GenerationQuota | null): boolean {
  return Boolean(
    quota &&
    quota.generationAvailable &&
    quota.remainingToday > 0 &&
    quota.activeGenerationId === null,
  );
}

export function NewEntry({ config, onActivityChange }: NewEntryProps) {
  const navigate = useNavigate();
  const requestId = useRef(crypto.randomUUID());
  const activeRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const [initialDate] = useState(() => jstToday());
  const [saved, setSaved] = useState<Entry | null>(null);
  const [date, setDate] = useState(initialDate);
  const [body, setBody] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingSave, setPendingSave] = useState<boolean | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [generationCheckEntry, setGenerationCheckEntry] = useState<Entry | null>(null);
  const [quota, setQuota] = useState<GenerationQuota | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<Generation | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>('loading');
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';
  const configAllowsGeneration = config.dataMode !== 'sample' && config.generationAvailable;
  const sessionRequired = config.dataMode === 'live' && quotaState === 'session-required';
  const canGenerate =
    configAllowsGeneration &&
    (sessionRequired || (quotaState === 'ready' && generationIsAvailable(quota)));
  const dirty = saved === null && (body.length > 0 || date !== initialDate);

  const refreshQuota = useCallback(async (): Promise<GenerationQuota | null> => {
    try {
      const currentQuota = await getQuotaForExistingSession();
      if (!activeRef.current) return null;
      setQuota(currentQuota);
      if (!currentQuota) {
        setActiveGeneration(null);
        setQuotaState(config.dataMode === 'live' ? 'session-required' : 'unavailable');
        return null;
      }
      setQuotaState('ready');
      if (currentQuota.activeGenerationId) {
        const current = await getGeneration(currentQuota.activeGenerationId).catch(() => null);
        if (activeRef.current) setActiveGeneration(current);
      } else {
        setActiveGeneration(null);
      }
      return currentQuota;
    } catch {
      if (activeRef.current) {
        setQuota(null);
        setActiveGeneration(null);
        setQuotaState('unavailable');
      }
      return null;
    }
  }, [config.dataMode]);

  useLayoutEffect(() => {
    if (activeRef.current) onActivityChange({ dirty, busy });
  }, [busy, dirty, onActivityChange]);

  useEffect(() => {
    activeRef.current = true;
    const refreshTimer = window.setTimeout(() => void refreshQuota(), 0);
    return () => {
      window.clearTimeout(refreshTimer);
      activeRef.current = false;
      onActivityChange({ dirty: false, busy: false });
    };
  }, [onActivityChange, refreshQuota]);

  async function persist(makeComic: boolean, registrationToken?: string) {
    const parsed = createEntrySchema.safeParse({
      createRequestId: requestId.current,
      diaryDate: date,
      body,
      consentVersion: config.consentVersion,
    });
    if (!parsed.success) {
      setError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      return;
    }
    if (registrationToken) {
      await registerAnonymousSession(registrationToken);
      if (!activeRef.current) return;
    }
    let entry = saved;
    if (!entry) {
      entry = await api<Entry>('/entries', { method: 'POST', body: JSON.stringify(parsed.data) });
      if (!activeRef.current) return;
      setSaved(entry);
      onActivityChange({ dirty: false, busy: makeComic && config.dataMode === 'mock' });
    }
    if (makeComic && config.dataMode === 'mock') {
      const currentQuota = await refreshQuota();
      if (!activeRef.current) return;
      if (!generationIsAvailable(currentQuota)) {
        setError(
          currentQuota?.activeGenerationId
            ? '別の漫画を作成しています。先に進行中の記録を確認してください。'
            : currentQuota?.remainingToday === 0
              ? '本日の生成上限に達しています。日記は保存しました。'
              : '利用枠を確認できないため、漫画の受付を停止しています。日記は保存しました。',
        );
        onActivityChange({ dirty: false, busy: false });
        return;
      }
      try {
        await generate(entry);
      } catch (failure) {
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
    setError('');
    const parsed = createEntrySchema.safeParse({
      createRequestId: requestId.current,
      diaryDate: date,
      body,
      consentVersion: config.consentVersion,
    });
    if (!parsed.success) {
      setError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      return;
    }
    if (!consent) {
      setError('保存と匿名利用の条件を確認してください。');
      return;
    }
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
    if (!consent) {
      setError('同意が確認できないため匿名登録を停止しました。');
      return;
    }
    if (!captchaToken) {
      setError('匿名登録には新しい確認が必要です。');
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
      if (activeRef.current) navigate(`/entries/${generationCheckEntry.id}`);
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

  return (
    <>
      <p className="eyebrow">今日の記録</p>
      <h1>どんな一日でしたか。</h1>
      <p>うまくまとめなくて大丈夫。覚えておきたいことを、そのまま。</p>
      {config.dataMode === 'live' && (
        <p className="hint">
          匿名セッションはこのブラウザに保存されます。ブラウザデータを削除した場合や別端末では復旧できず、既存の記録を引き継げません。保存した記録は保存後
          {config.retentionDays}日を過ぎると閲覧できなくなります。
          {config.generationAvailable
            ? '漫画は固定サンプルです。入力内容は反映されず、AIにも送信されません。'
            : '現在、漫画生成は利用できません。'}
        </p>
      )}
      {quota && (
        <GenerationQuotaStatus
          quota={quota}
          activeGeneration={activeGeneration}
          currentGenerationId={null}
        />
      )}
      {quotaState === 'unavailable' && (
        <p className="hint" role="alert">
          利用枠を確認できないため、漫画の受付を停止しています。日記の保存は引き続きできます。
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(canGenerate);
        }}
      >
        <fieldset disabled={busy || saved !== null}>
          <label htmlFor="date">日付</label>
          <input
            id="date"
            type="date"
            value={date}
            max={jstToday()}
            onChange={(event) => setDate(event.target.value)}
            required
          />
          <label htmlFor="body">日記</label>
          <textarea
            id="body"
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="今日は何がありましたか？"
            required
            aria-describedby="count"
          />
          <p id="count" className="hint">
            {[...body.trim()].length} / 1,000文字
          </p>
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
                if (!event.target.checked) setPendingSave(null);
              }}
            />
            {config.dataMode === 'mock'
              ? '記録は一時保存で、予告なく消えることがあります。AIには送信されません。'
              : `記録を保存し、保存後${config.retentionDays}日を過ぎると閲覧できなくなることに同意します。匿名利用のため、ブラウザデータを失うと過去の記録を復旧できません。`}
          </label>
        </fieldset>
        {pendingSave !== null && config.dataMode === 'live' && (
          <section aria-label="匿名登録">
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
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {config.dataMode === 'live' && !config.generationAvailable && (
          <p className="hint">現在、漫画生成は利用できません。</p>
        )}
        {config.dataMode === 'mock' && config.generationAvailable && (
          <p className="hint">固定サンプルです。入力内容は反映されず、AIにも送信されません。</p>
        )}
        {saved && (
          <p className="saved">
            記録を保存しました。<Link to={`/entries/${saved.id}`}>保存した記録を見る</Link>
          </p>
        )}
        {generationCheckEntry && (
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => void checkGenerationReceipt()}
          >
            {busy ? '受付結果を確認しています…' : '受付結果を確認'}
          </button>
        )}
        <div className="actions">
          {canGenerate ? (
            <button disabled={busy || saved !== null} type="submit">
              {busy
                ? '保存しています…'
                : config.dataMode === 'mock'
                  ? '保存して固定サンプルを見る'
                  : config.generationAvailable
                    ? '保存して固定サンプルを見る'
                    : '保存して記録を見る'}
            </button>
          ) : (
            <button disabled type="button">
              {quotaState === 'loading' && configAllowsGeneration
                ? '利用枠を確認しています…'
                : quotaState === 'unavailable' && configAllowsGeneration
                  ? '利用枠を確認できません'
                  : '漫画生成は利用できません'}
            </button>
          )}
          <button
            className="secondary"
            disabled={busy || saved !== null}
            type="button"
            onClick={() => void save(false)}
          >
            下書き保存
          </button>
          {quotaState === 'unavailable' && !saved && (
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
        </div>
      </form>
    </>
  );
}
