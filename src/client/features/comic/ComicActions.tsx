import { useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { api } from '../../lib/api';
import { exportComic } from './exportComic';
import './comic-actions.css';

export function ComicActions({
  comic,
  images,
  generationId,
  ready,
  getFreshImages,
}: {
  comic: ComicDocument;
  images: Record<string, string>;
  generationId?: string;
  ready: boolean;
  getFreshImages?: () => Promise<Record<string, string>>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const [url, setUrl] = useState('');
  async function download() {
    setBusy(true);
    setMessage('');
    try {
      const blob = await exportComic(comic, getFreshImages ? await getFreshImages() : images);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'manga-nikki.png';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setMessage('画像を保存しました。ダウンロード先を確認してください。');
    } catch {
      setMessage('画像を保存できませんでした。画像を再読み込みして、もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ path: string }>(`/generations/${generationId}/share`, {
        method: 'POST',
      });
      if (!/^\/shared\/[a-f0-9]{64}$/.test(result.path)) throw new Error('INVALID_SHARE_URL');
      setUrl(new URL(result.path, location.origin).href);
      setMessage('共有URLを作りました。');
    } catch {
      setMessage('共有URLを作れませんでした。時間をおいて再試行してください。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="comic-actions">
      <div className="comic-actions-buttons">
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready || busy}
          onClick={() => void download()}
        >
          {busy ? '準備しています…' : '画像を保存'}
        </button>
        {generationId && (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            aria-expanded={sharing}
            onClick={() => setSharing(!sharing)}
          >
            URLで共有
          </button>
        )}
      </div>
      {sharing && (
        <div className="comic-share-options">
          <p>
            この漫画の画像・タイトル・セリフ・説明文を、URLを知っている人がログインなしで見られます。元の日記本文は共有しません。日記の削除や保存期限で共有も終了します。
          </p>
          {!url ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void publish()}
            >
              共有URLを作る
            </button>
          ) : (
            <>
              <label className="comic-share-url">
                共有URL
                <input readOnly value={url} onFocus={(event) => event.target.select()} />
              </label>
              <div className="comic-actions-buttons">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(url)
                      .then(() => setMessage('URLをコピーしました。'))
                      .catch(() => setMessage('URLを選択してコピーしてください。'));
                    if (!navigator.clipboard) setMessage('URLを選択してコピーしてください。');
                  }}
                >
                  URLをコピー
                </button>
                {typeof navigator.share === 'function' && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      void navigator.share({ title: comic.title, url }).catch((error: unknown) => {
                        if (!(error instanceof DOMException && error.name === 'AbortError'))
                          setMessage('共有できませんでした。URLをコピーして送ってください。');
                      });
                    }}
                  >
                    友達に送る
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <output className="comic-action-message">{message}</output>
    </div>
  );
}
