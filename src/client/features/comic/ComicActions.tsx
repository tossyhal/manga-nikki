import { useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { api } from '../../lib/api';
import { exportComic } from './exportComic';
import './comic-actions.css';

const shareOperationTimeoutMs = 15_000;

async function withShareOperationTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error('SHARE_OPERATION_TIMEOUT')),
      shareOperationTimeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function createShareUrl(generationId: string): Promise<string> {
  const controller = new AbortController();
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      controller.abort();
      reject(new Error('SHARE_REQUEST_TIMEOUT'));
    }, shareOperationTimeoutMs);
  });
  try {
    const result = await Promise.race([
      api<{ path: string }>(`/generations/${generationId}/share`, {
        method: 'POST',
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!/^\/shared\/[a-f0-9]{64}$/.test(result.path)) throw new Error('INVALID_SHARE_URL');
    return new URL(result.path, location.origin).href;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function writeNewShareUrlToClipboard(shareUrl: Promise<string>): Promise<void> {
  const text = shareUrl.then((value) => new Blob([value], { type: 'text/plain' }));
  // Safariはwrite()時点のユーザー操作を確認するため、ClipboardItem生成失敗時も遅延値の拒否を監視する。
  void text.catch(() => undefined);
  try {
    const item = new ClipboardItem({ 'text/plain': text });
    return withShareOperationTimeout(navigator.clipboard.write([item]));
  } catch (error) {
    return Promise.reject(error);
  }
}

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
  function writeUrlToClipboard(value: string) {
    if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
    return withShareOperationTimeout(navigator.clipboard.writeText(value));
  }
  function showCopyFailure() {
    setShowUrlFallback(true);
    setMessage('URLをコピーできませんでした。下のURLを選択してコピーしてください。');
  }
  async function share() {
    if (!generationId || shareInFlight.current) return;
    shareInFlight.current = true;
    setSharing(true);
    setMessage('');
    try {
      if (url) {
        try {
          await writeUrlToClipboard(url);
          setShowUrlFallback(false);
          setMessage('URLをコピーしました。');
        } catch {
          showCopyFailure();
        }
        return;
      }

      if (
        typeof navigator.clipboard?.write === 'function' &&
        typeof ClipboardItem !== 'undefined'
      ) {
        const shareUrlPromise = createShareUrl(generationId).then((shareUrl) => {
          setUrl(shareUrl);
          return shareUrl;
        });
        const clipboardPromise = writeNewShareUrlToClipboard(shareUrlPromise);
        const [shareResult, clipboardResult] = await Promise.allSettled([
          shareUrlPromise,
          clipboardPromise,
        ]);
        if (shareResult.status === 'rejected') {
          setMessage('共有URLを作成できませんでした。時間をおいて再試行してください。');
          return;
        }
        if (clipboardResult.status === 'rejected') {
          showCopyFailure();
          return;
        }
        setShowUrlFallback(false);
        setMessage('URLをコピーしました。');
        return;
      }

      let shareUrl: string;
      try {
        shareUrl = await createShareUrl(generationId);
        setUrl(shareUrl);
      } catch {
        setMessage('共有URLを作成できませんでした。時間をおいて再試行してください。');
        return;
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
