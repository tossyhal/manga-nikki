import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

type PwaNoticeProps = {
  diaryDirty: boolean;
  diaryBusy: boolean;
};

export function PwaNotice({ diaryDirty, diaryBusy }: PwaNoticeProps) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  const updateBlocked = diaryDirty || diaryBusy;

  return (
    <>
      {!online && (
        <output className="pwa-notice" aria-live="polite">
          <p>
            オフラインです。架空サンプルは見られますが、日記の保存・履歴の取得・漫画の生成には通信が必要です。日記本文や生成画像はオフライン用に保存しません。
          </p>
        </output>
      )}
      {offlineReady && (
        <output className="pwa-notice" aria-live="polite">
          <p>架空サンプルを含む画面をオフラインで表示できます。日記本文や生成画像は対象外です。</p>
          <button className="secondary" type="button" onClick={() => setOfflineReady(false)}>
            閉じる
          </button>
        </output>
      )}
      {needRefresh && (
        <output className="pwa-notice" aria-live="polite">
          <p>新しいバージョンを利用できます。更新は日記の入力・保存が終わってから行えます。</p>
          {updateBlocked && (
            <p className="hint">
              {diaryBusy
                ? '日記の保存・生成中は更新できません。'
                : '未保存の日記があります。下書き保存後に更新してください。'}
            </p>
          )}
          <div className="pwa-notice-actions">
            <button
              type="button"
              disabled={updateBlocked}
              onClick={() => void updateServiceWorker(true)}
            >
              更新する
            </button>
            <button className="secondary" type="button" onClick={() => setNeedRefresh(false)}>
              あとで
            </button>
          </div>
        </output>
      )}
    </>
  );
}
