import { useEffect, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';

export function Comic({
  comic,
  images,
  mock = false,
  imageError = false,
  titleAs: Title = 'h2',
  hideTitle = false,
}: {
  comic: ComicDocument;
  images: Record<string, string>;
  mock?: boolean;
  imageError?: boolean;
  /** 漫画タイトルの見出しレベル。周囲の見出し階層に合わせて選ぶ */
  titleAs?: 'h2' | 'h3';
  /** 周囲に同じ漫画タイトルの見出しがある場合は重複を避ける */
  hideTitle?: boolean;
}) {
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<string[]>([]);
  const zoomDialogRef = useRef<HTMLDialogElement>(null);
  const pageImageFailed =
    comic.visual.kind === 'page' && (imageError || failedImageIds.includes(comic.visual.assetId));

  useEffect(() => {
    const dialog = zoomDialogRef.current;
    if (!dialog) return;
    if (zoomed && !dialog.open) dialog.showModal();
    if (!zoomed && dialog.open) dialog.close();
  }, [zoomed]);

  return (
    <>
      <figure className={`comic is-${comic.visual.kind}`}>
        <div className={`comic-images is-${comic.visual.kind}`}>
          {ids.map((id, index) => {
            const src = images[id];
            const imageFailed = failedImageIds.includes(id);
            const panel = comic.panels[index];
            const alt =
              comic.visual.kind === 'page'
                ? `${comic.title}の4コマ漫画`
                : `${index + 1}コマ目：${panel?.scene ?? comic.title}`;
            const image = src && !imageFailed && (
              <button
                className="comic-image-button"
                type="button"
                aria-label={`${alt}を拡大`}
                onClick={() => setZoomed({ src, alt })}
              >
                <img
                  src={src}
                  loading="lazy"
                  decoding="async"
                  alt={alt}
                  onError={() =>
                    setFailedImageIds((current) =>
                      current.includes(id) ? current : [...current, id],
                    )
                  }
                />
              </button>
            );
            return (
              <figure className="comic-panel-card" key={id}>
                {comic.visual.kind === 'panels' ? (
                  <div className="comic-panel-image-frame">{image}</div>
                ) : (
                  image
                )}
                {comic.visual.kind === 'panels' && panel && (
                  <figcaption className="comic-panel-caption">
                    <span className="comic-panel-number">{panel.index}</span>
                    <div>
                      <p>{panel.caption || panel.scene}</p>
                      {panel.dialogue && <p>「{panel.dialogue}」</p>}
                      {panel.caption && <span className="sr-only">{panel.scene}</span>}
                    </div>
                  </figcaption>
                )}
              </figure>
            );
          })}
        </div>
        <figcaption className="comic-transcript">
          {!hideTitle && <Title className="comic-title sr-only">{comic.title}</Title>}
          {comic.visual.kind === 'page' && comic.visual.textMode === 'external' && (
            <details className="comic-script" {...(pageImageFailed ? { open: true } : {})}>
              <summary>4コマの内容を読む</summary>
              <ol>
                {comic.panels.map((panel) => (
                  <li key={panel.index}>
                    <p>{panel.scene}</p>
                    {panel.caption && <p>{panel.caption}</p>}
                    {panel.dialogue && <p>「{panel.dialogue}」</p>}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {comic.visual.kind === 'page' && comic.visual.textMode === 'embedded' && (
            <>
              {!pageImageFailed && (
                <ol className="sr-only">
                  {comic.panels.map((panel) => (
                    <li key={panel.index}>
                      <p>{panel.scene}</p>
                      {panel.caption && <p>{panel.caption}</p>}
                      {panel.dialogue && <p>「{panel.dialogue}」</p>}
                    </li>
                  ))}
                </ol>
              )}
              {pageImageFailed && (
                <details className="comic-script comic-image-fallback" open>
                  <summary>漫画の画像を表示できません。内容を読む</summary>
                  <ol>
                    {comic.panels.map((panel) => (
                      <li key={panel.index}>
                        <p>{panel.scene}</p>
                        {panel.caption && <p>{panel.caption}</p>}
                        {panel.dialogue && <p>「{panel.dialogue}」</p>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
          {mock && <small>固定サンプルです。入力内容は反映されず、AIにも送信されません。</small>}
        </figcaption>
      </figure>
      <dialog
        ref={zoomDialogRef}
        className="comic-zoom-dialog"
        aria-label="漫画画像"
        onCancel={(event) => {
          event.preventDefault();
          setZoomed(null);
        }}
        onClose={() => setZoomed(null)}
      >
        {zoomed && (
          <div className="comic-zoom-content">
            <button
              className="icon-button comic-zoom-close"
              type="button"
              aria-label="画像を閉じる"
              onClick={() => setZoomed(null)}
            >
              <Icon name="close" />
            </button>
            <img src={zoomed.src} alt={zoomed.alt} />
          </div>
        )}
      </dialog>
    </>
  );
}
