import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useOnlineStatus } from '../lib/useOnlineStatus';

type PwaNoticeProps = {
  diaryDirty: boolean;
  diaryBusy: boolean;
  hideOfflineNotice?: boolean;
};

export function PwaNotice({ diaryDirty, diaryBusy, hideOfflineNotice = false }: PwaNoticeProps) {
  const updateBlocked = diaryDirty || diaryBusy;
  const updateBlockedRef = useRef(updateBlocked);
  useLayoutEffect(() => {
    updateBlockedRef.current = updateBlocked;
  }, [updateBlocked]);
  const reloadApprovedRef = useRef(false);
  const [reloadPending, setReloadPending] = useState(false);
  const onNeedReload = useCallback(() => {
    if (reloadApprovedRef.current && !updateBlockedRef.current) {
      reloadApprovedRef.current = false;
      window.location.reload();
      return;
    }
    reloadApprovedRef.current = false;
    setReloadPending(true);
  }, []);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ onNeedReload });
  const { online } = useOnlineStatus();

  function requestUpdate() {
    if (updateBlockedRef.current) return;
    if (reloadPending) {
      window.location.reload();
      return;
    }
    reloadApprovedRef.current = true;
    void updateServiceWorker();
  }

  function dismissUpdate() {
    reloadApprovedRef.current = false;
    setReloadPending(false);
    setNeedRefresh(false);
  }

  return (
    <>
      {!online && !hideOfflineNotice && (
        <output className="pwa-notice" aria-live="polite">
          <p>
            オフラインです。架空サンプルは見られますが、日記の保存・履歴の取得・漫画の生成には通信が必要です。日記本文や生成画像はオフライン用に保存しません。
          </p>
        </output>
      )}
      {offlineReady && (
        <output className="pwa-notice" aria-live="polite">
          <p>架空サンプルを含む画面をオフラインで表示できます。日記本文や生成画像は対象外です。</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setOfflineReady(false)}
          >
            閉じる
          </button>
        </output>
      )}
      {(needRefresh || reloadPending) && (
        <output className="pwa-notice" aria-live="polite">
          <p>
            {reloadPending
              ? '別のタブで新しいバージョンが適用されました。この画面は入力内容を保つため再読み込みしていません。'
              : '新しいバージョンを利用できます。更新は日記の入力・保存が終わってから行えます。'}
          </p>
          {updateBlocked && (
            <p className="hint">
              {diaryBusy
                ? '日記の保存・生成中は更新できません。'
                : '未保存の日記があります。下書き保存後に更新してください。'}
            </p>
          )}
          <div className="pwa-notice-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={updateBlocked}
              onClick={requestUpdate}
            >
              {reloadPending ? 'この画面を再読み込み' : '更新する'}
            </button>
            <button className="button button-secondary" type="button" onClick={dismissUpdate}>
              あとで
            </button>
          </div>
        </output>
      )}
    </>
  );
}
