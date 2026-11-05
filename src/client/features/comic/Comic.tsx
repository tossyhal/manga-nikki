import { useEffect, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';

function ComicTranscript({ comic }: { comic: ComicDocument }) {
  return (
    <ol>
      {comic.panels.map((panel) => (
        <li key={panel.index}>
          <p>{panel.scene}</p>
          {panel.caption && panel.caption !== panel.scene && <p>{panel.caption}</p>}
          {panel.dialogue && <p>「{panel.dialogue}」</p>}
        </li>
      ))}
    </ol>
  );
}

function RetryImagesButton({
  onRetryImages,
  imageRetrying,
}: {
  onRetryImages?: () => void;
  imageRetrying: boolean;
}) {
  if (!onRetryImages) return null;
  return (
    <button
      className="button-text comic-retry-action"
      type="button"
      disabled={imageRetrying}
      onClick={onRetryImages}
    >
      {imageRetrying ? '画像を再取得しています…' : '画像を再読み込み'}
    </button>
  );
}

export function Comic({
  comic,
  images,
  imageError = false,
  imageErrors = [],
  imageLoading = false,
  imageRetrying = false,
  onRetryImages,
  onImageError,
  titleAs: Title = 'h2',
  hideTitle = false,
}: {
  comic: ComicDocument;
  images: Record<string, string>;
  mock?: boolean;
  imageError?: boolean;
  imageErrors?: string[];
  imageLoading?: boolean;
  imageRetrying?: boolean;
  onRetryImages?: () => void;
  onImageError?: (assetId: string) => boolean;
  /** 漫画タイトルの見出しレベル。周囲の見出し階層に合わせて選ぶ */
  titleAs?: 'h2' | 'h3';
  /** 周囲に同じ漫画タイトルの見出しがある場合は重複を避ける */
  hideTitle?: boolean;
}) {
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  const [zoomed, setZoomed] = useState<{ assetId: string; alt: string } | null>(null);
  const [failedImageUrls, setFailedImageUrls] = useState<Record<string, string>>({});
  const zoomDialogRef = useRef<HTMLDialogElement>(null);
  const imageFailed = (id: string) =>
    imageError ||
    imageErrors.includes(id) ||
    Boolean(images[id] && failedImageUrls[id] === images[id]) ||
    (!images[id] && !imageLoading);
  const pageImageFailed = comic.visual.kind === 'page' && imageFailed(comic.visual.assetId);
  const anyImageFailed = ids.some(imageFailed);

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
            const failed = imageFailed(id);
            const panel = comic.panels[index];
            const alt =
              comic.visual.kind === 'page'
                ? `${comic.title}の4コマ漫画`
                : `${index + 1}コマ目：${panel?.scene ?? comic.title}`;
            const image =
              src && !failed ? (
                <button
                  className="comic-image-button"
                  type="button"
                  aria-label={`${alt}を拡大`}
                  onClick={() => setZoomed({ assetId: id, alt })}
                >
                  <img
                    src={src}
                    loading="lazy"
                    decoding="async"
                    alt={alt}
                    onError={() => {
                      if (onImageError?.(id)) return;
                      const src = images[id];
                      if (src) setFailedImageUrls((current) => ({ ...current, [id]: src }));
                    }}
                  />
                </button>
              ) : (
                <div
                  className={`comic-image-placeholder${failed ? ' is-error' : ''}`}
                  role={failed ? 'img' : 'status'}
                  aria-label={failed ? '漫画の画像を表示できません' : undefined}
                  aria-live={failed ? undefined : 'polite'}
                >
                  {failed ? '漫画の画像を表示できません。' : '漫画画像を読み込んでいます…'}
                </div>
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
                      {failed ? (
                        <>
                          <p>{panel.scene}</p>
                          {panel.caption && panel.caption !== panel.scene && <p>{panel.caption}</p>}
                        </>
                      ) : (
                        <>
                          <p>{panel.caption || panel.scene}</p>
                          {panel.caption && panel.caption !== panel.scene && (
                            <span className="sr-only">{panel.scene}</span>
                          )}
                        </>
                      )}
                      {panel.dialogue && <p>「{panel.dialogue}」</p>}
                    </div>
                  </figcaption>
                )}
              </figure>
            );
          })}
        </div>
        <figcaption className="comic-transcript">
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {anyImageFailed ? '漫画の画像を表示できません。' : ''}
          </p>
          {!hideTitle && <Title className="comic-title sr-only">{comic.title}</Title>}
          {comic.visual.kind === 'page' && comic.visual.textMode === 'external' && (
            <details className="comic-script" {...(pageImageFailed ? { open: true } : {})}>
              <summary>
                {pageImageFailed
                  ? '漫画の画像を表示できません。4コマの内容を読む'
                  : '4コマの内容を読む'}
              </summary>
              <ComicTranscript comic={comic} />
              {pageImageFailed && (
                <RetryImagesButton onRetryImages={onRetryImages} imageRetrying={imageRetrying} />
              )}
            </details>
          )}
          {comic.visual.kind === 'page' && comic.visual.textMode === 'embedded' && (
            <>
              {!pageImageFailed && (
                <ol className="sr-only">
                  {comic.panels.map((panel) => (
                    <li key={panel.index}>
                      <p>{panel.scene}</p>
                      {panel.caption && panel.caption !== panel.scene && <p>{panel.caption}</p>}
                      {panel.dialogue && <p>「{panel.dialogue}」</p>}
                    </li>
                  ))}
                </ol>
              )}
              {pageImageFailed && (
                <details className="comic-script comic-image-fallback" open>
                  <summary>漫画の画像を表示できません。内容を読む</summary>
                  <ComicTranscript comic={comic} />
                  <RetryImagesButton onRetryImages={onRetryImages} imageRetrying={imageRetrying} />
                </details>
              )}
            </>
          )}
          {comic.visual.kind === 'panels' && anyImageFailed && (
            <details className="comic-script comic-image-fallback" open>
              <summary>
                漫画の画像を表示できません。各コマの内容はカードの下に表示しています
              </summary>
              <RetryImagesButton onRetryImages={onRetryImages} imageRetrying={imageRetrying} />
            </details>
          )}
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
            {imageFailed(zoomed.assetId) ? (
              <output className="comic-image-placeholder is-error" aria-live="polite">
                <span>漫画の画像を表示できません。</span>
                <RetryImagesButton onRetryImages={onRetryImages} imageRetrying={imageRetrying} />
              </output>
            ) : images[zoomed.assetId] ? (
              <img
                src={images[zoomed.assetId]}
                alt={zoomed.alt}
                onError={() => {
                  if (onImageError?.(zoomed.assetId)) return;
                  const src = images[zoomed.assetId];
                  if (src) setFailedImageUrls((current) => ({ ...current, [zoomed.assetId]: src }));
                }}
              />
            ) : (
              <output className="comic-zoom-status" aria-live="polite">
                {imageLoading
                  ? '画像を読み込んでいます…'
                  : '画像を表示できません。閉じて画像を再読み込みしてください。'}
              </output>
            )}
          </div>
        )}
      </dialog>
    </>
  );
}
