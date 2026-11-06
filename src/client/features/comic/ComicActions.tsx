import { useRef, useState } from 'react';
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const [url, setUrl] = useState('');
  const [showUrlFallback, setShowUrlFallback] = useState(false);
  const shareInFlight = useRef(false);
  async function download() {
    setSaving(true);
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
      setSaving(false);
    }
  }
  async function writeUrlToClipboard(value: string) {
    if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(value);
  }
  function showCopyFailure() {
    setShowUrlFallback(true);
    setMessage('URLをコピーできませんでした。下のURLを選択してコピーしてください。');
  }
  async function share() {
    if (shareInFlight.current) return;
    shareInFlight.current = true;
    setSharing(true);
    setMessage('');
    try {
      let shareUrl = url;
      if (!shareUrl) {
        try {
          const result = await api<{ path: string }>(`/generations/${generationId}/share`, {
            method: 'POST',
          });
          if (!/^\/shared\/[a-f0-9]{64}$/.test(result.path)) throw new Error('INVALID_SHARE_URL');
          shareUrl = new URL(result.path, location.origin).href;
          setUrl(shareUrl);
        } catch {
          setMessage('共有URLを作成できませんでした。時間をおいて再試行してください。');
          return;
        }
      }
      try {
        await writeUrlToClipboard(shareUrl);
        setShowUrlFallback(false);
        setMessage('URLをコピーしました。');
      } catch {
        showCopyFailure();
      }
    } finally {
      shareInFlight.current = false;
      setSharing(false);
    }
  }
  async function retryCopy() {
    if (!url) return;
    setMessage('');
    try {
      await writeUrlToClipboard(url);
      setShowUrlFallback(false);
      setMessage('URLをコピーしました。');
    } catch {
      showCopyFailure();
    }
  }
  return (
    <div className="comic-actions">
      <div className="comic-actions-buttons comic-actions-toolbar">
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready || saving || sharing}
          onClick={() => void download()}
        >
          {saving ? '画像を準備しています…' : '画像を保存'}
        </button>
        {generationId && (
          <button
            type="button"
            className="button button-secondary"
            disabled={saving || sharing}
            onClick={() => void share()}
          >
            {sharing ? '共有中…' : 'URLで共有'}
          </button>
        )}
      </div>
      {showUrlFallback && url && (
        <div className="comic-share-fallback">
          <label className="comic-share-url">
            共有URL
            <input readOnly value={url} onFocus={(event) => event.target.select()} />
          </label>
          <div className="comic-actions-buttons">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void retryCopy()}
            >
              もう一度コピー
            </button>
          </div>
        </div>
      )}
      <output className="comic-action-message" aria-live="polite">
        {message}
      </output>
    </div>
  );
}
