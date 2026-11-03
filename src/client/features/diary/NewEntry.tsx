import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { createEntrySchema, jstToday, type Entry } from '../../../shared/schemas';
import { RegistrationCaptcha } from './RegistrationCaptcha';
import { api, generate } from '../../lib/api';
import { registerAnonymousSession, getLiveAccessToken } from '../../lib/auth';
import type { ClientConfig } from '../../lib/config';

export function NewEntry({ config }: { config: ClientConfig }) {
  const navigate = useNavigate();
  const requestId = useRef(crypto.randomUUID());
  const [saved, setSaved] = useState<Entry | null>(null);
  const [date, setDate] = useState(jstToday());
  const [body, setBody] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingSave, setPendingSave] = useState<boolean | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const canGenerate = config.dataMode === 'mock' && config.generationAvailable;

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
    if (registrationToken) await registerAnonymousSession(registrationToken);
    let entry = saved;
    if (!entry) {
      entry = await api<Entry>('/entries', { method: 'POST', body: JSON.stringify(parsed.data) });
      setSaved(entry);
    }
    if (makeComic) await generate(entry);
    navigate(`/entries/${entry.id}`);
  }

  async function save(makeComic: boolean) {
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
    setBusy(true);
    try {
      if (config.dataMode === 'live') {
        const accessToken = await getLiveAccessToken();
        if (!accessToken) {
          const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
          if (!siteKey) {
            throw new Error(
              '匿名登録用CAPTCHAが設定されていません。VITE_TURNSTILE_SITE_KEYを確認してください。',
            );
          }
          setPendingSave(makeComic);
          setCaptchaAttempt((attempt) => attempt + 1);
          return;
        }
      }
      await persist(makeComic);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function completeRegistration(captchaToken: string) {
    const makeComic = pendingSave;
    setPendingSave(null);
    if (makeComic === null) return;
    if (!consent) {
      setError('同意が確認できないため匿名登録を停止しました。');
      return;
    }
    if (!captchaToken) {
      setError('匿名登録には登録用CAPTCHAの確認が必要です。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await persist(makeComic, captchaToken);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  function failCaptcha() {
    setPendingSave(null);
    setError('CAPTCHAを確認できませんでした。通信を確認して、もう一度保存してください。');
  }

  return (
    <>
      <p className="eyebrow">今日の記録</p>
      <h1>どんな一日でしたか。</h1>
      <p>うまくまとめなくて大丈夫。覚えておきたいことを、そのまま。</p>
      {config.dataMode === 'live' && (
        <p className="hint">
          匿名セッションはこのブラウザに保存されます。ブラウザデータを削除した場合や別端末では復旧できず、既存の記録を引き継げません。保存期間は最大
          {config.retentionDays}日です。生成機能を利用する場合は日記本文をAIへ送信します。
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
              ? 'この端末からの開発確認に使います。保存は開発サーバーの一時メモリで、再起動すると消えます。AI・クラウドへは送信しません。'
              : `日記を保存APIへ送信し、最大${config.retentionDays}日保存することに同意します。匿名利用のため、ブラウザデータを失うと過去の記録を復旧できません。`}
          </label>
        </fieldset>
        {pendingSave !== null && config.dataMode === 'live' && (
          <section aria-label="匿名登録">
            <p>匿名登録を続けるため、登録用CAPTCHAを確認してください。</p>
            <RegistrationCaptcha
              key={captchaAttempt}
              siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? ''}
              requestKey={captchaAttempt}
              onToken={(token) => void completeRegistration(token)}
              onError={failCaptcha}
            />
          </section>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {config.dataMode === 'live' && (
          <p className="hint">実AI生成は生成用CAPTCHAとの統合が未対応のため停止しています。</p>
        )}
        <div className="actions">
          {canGenerate ? (
            <button disabled={busy} type="submit">
              {busy ? '保存しています…' : '保存してモック漫画を見る'}
            </button>
          ) : (
            <button disabled type="button">
              漫画生成は利用できません
            </button>
          )}
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => void save(false)}
          >
            下書き保存
          </button>
        </div>
      </form>
    </>
  );
}
