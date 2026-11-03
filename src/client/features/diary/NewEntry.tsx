import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { createEntrySchema, jstToday, type Entry } from '../../../shared/schemas';
import { api, generate } from '../../lib/api';

export type DiaryActivity = { dirty: boolean; busy: boolean };

type NewEntryProps = {
  onActivityChange: (activity: DiaryActivity) => void;
};

export function NewEntry({ onActivityChange }: NewEntryProps) {
  const navigate = useNavigate();
  const requestId = useRef(crypto.randomUUID());
  const [initialDate] = useState(() => jstToday());
  const [saved, setSaved] = useState<Entry | null>(null);
  const [date, setDate] = useState(initialDate);
  const [body, setBody] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = saved === null && (body.length > 0 || date !== initialDate);

  useLayoutEffect(() => {
    onActivityChange({ dirty, busy });
  }, [busy, dirty, onActivityChange]);

  useEffect(() => () => onActivityChange({ dirty: false, busy: false }), [onActivityChange]);

  async function save(makeComic: boolean) {
    setError('');
    const parsed = createEntrySchema.safeParse({
      createRequestId: requestId.current,
      diaryDate: date,
      body,
      consentVersion: 'v1',
    });
    if (!parsed.success) {
      setError('日付は今日以前、本文は1〜1,000文字で入力してください。');
      return;
    }
    if (!consent) {
      setError('開発用モックの保存条件を確認してください。');
      return;
    }
    setBusy(true);
    try {
      let entry = saved;
      if (!entry) {
        entry = await api<Entry>('/entries', { method: 'POST', body: JSON.stringify(parsed.data) });
        setSaved(entry);
      }
      if (makeComic) await generate(entry);
      navigate(`/entries/${entry.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="eyebrow">今日の記録</p>
      <h1>どんな一日でしたか。</h1>
      <p>うまくまとめなくて大丈夫。覚えておきたいことを、そのまま。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <fieldset disabled={busy || saved !== null}>
          <label htmlFor="date">日付</label>
          <input
            id="date"
            type="date"
            value={date}
            max={jstToday()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <label htmlFor="body">日記</label>
          <textarea
            id="body"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
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
              onChange={(e) => setConsent(e.target.checked)}
            />
            この端末からの開発確認に使います。保存は開発サーバーの一時メモリで、再起動すると消えます。AI・クラウドへは送信しません。
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button disabled={busy} type="submit">
            {busy ? '保存しています…' : '保存してモック漫画を見る'}
          </button>
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
