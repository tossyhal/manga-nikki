import { useCallback, useEffect, useState, type RefCallback } from 'react';
import type { Entry, EntryDetail, Generation } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';
import { getAssetUrl, getEntry } from '../../lib/api';

export type EntryPreviewOptions = { eager?: boolean };

export type EntryPreview = {
  imageUrl: string | null;
  generation: Generation | null;
  isLoading: boolean;
  error?: string;
  observeRef: RefCallback<HTMLElement>;
};

type PreviewResult = Omit<EntryPreview, 'observeRef'> & { key: string | null };

export function useEntryPreview(
  entry: Entry | null,
  { eager = false }: EntryPreviewOptions = {},
): EntryPreview {
  const entryId = entry?.id ?? null;
  const revision = entry?.revision ?? null;
  const generationId = entry?.latestGenerationId ?? null;
  const key = entry ? `${entry.id}:${revision}:${generationId ?? 'draft'}` : null;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [result, setResult] = useState<PreviewResult>({
    key: null,
    imageUrl: null,
    generation: null,
    isLoading: false,
  });
  const observeRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (!eager) setTarget(node);
    },
    [eager],
  );

  useEffect(() => {
    let active = true;
    let started = false;

    if (!entryId || !generationId) {
      return () => {
        active = false;
      };
    }

    const loadPreview = async () => {
      if (started) return;
      started = true;
      setResult({ key, imageUrl: null, generation: null, isLoading: true });

      let detail: EntryDetail;
      try {
        detail = await getEntry(entryId);
      } catch {
        if (active) {
          setResult({
            key,
            imageUrl: null,
            generation: null,
            isLoading: false,
            error: '記録の状態を確認できません。',
          });
        }
        return;
      }
      if (!active) return;
      const generation = detail.latestGeneration;
      if (
        !generation ||
        detail.id !== entryId ||
        detail.revision !== revision ||
        detail.latestGenerationId !== generationId ||
        generation.id !== generationId ||
        generation.entryId !== entryId ||
        generation.entryRevision !== revision
      ) {
        setResult({ key, imageUrl: null, generation: null, isLoading: false });
        return;
      }

      if (generation.status !== 'succeeded') {
        setResult({ key, imageUrl: null, generation, isLoading: false });
        return;
      }

      const assetId =
        generation.comic.visual.kind === 'page'
          ? generation.comic.visual.assetId
          : generation.comic.visual.assetIds[0];
      setResult({ key, imageUrl: null, generation, isLoading: true });
      try {
        const asset = await getAssetUrl(assetId);
        if (active) setResult({ key, imageUrl: asset.url, generation, isLoading: false });
      } catch {
        if (active) {
          setResult({
            key,
            imageUrl: null,
            generation,
            isLoading: false,
            error: '画像を表示できません。',
          });
        }
      }
    };

    if (eager) {
      void loadPreview();
    } else if (target) {
      if (typeof IntersectionObserver === 'undefined') {
        const loadWhenVisible = () => {
          if (window.innerHeight <= 0) return;
          const bounds = target.getBoundingClientRect();
          if (bounds.top < window.innerHeight + 80 && bounds.bottom > -80) {
            window.removeEventListener('scroll', loadWhenVisible);
            window.removeEventListener('resize', loadWhenVisible);
            void loadPreview();
          }
        };
        window.addEventListener('scroll', loadWhenVisible, { passive: true });
        window.addEventListener('resize', loadWhenVisible);
        loadWhenVisible();
        return () => {
          active = false;
          window.removeEventListener('scroll', loadWhenVisible);
          window.removeEventListener('resize', loadWhenVisible);
        };
      } else {
        const observer = new IntersectionObserver(
          ([observed]) => {
            if (observed?.isIntersecting) {
              observer.disconnect();
              void loadPreview();
            }
          },
          { rootMargin: '80px' },
        );
        observer.observe(target);
        return () => {
          active = false;
          observer.disconnect();
        };
      }
    }

    return () => {
      active = false;
    };
  }, [eager, entryId, generationId, key, revision, target]);

  const current =
    result.key === key
      ? result
      : {
          key,
          imageUrl: null,
          generation: null,
          isLoading: Boolean(eager && entryId && generationId),
        };
  return { ...current, observeRef };
}

export function EntryThumbnail({
  preview,
  className = '',
  iconSize = 30,
  alt = '',
  ariaHidden = true,
  placeholderLabel,
}: {
  preview: EntryPreview;
  className?: string;
  iconSize?: number;
  alt?: string;
  ariaHidden?: boolean;
  placeholderLabel?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const { imageUrl: previewImageUrl, observeRef } = preview;
  const imageUrl = previewImageUrl && failedUrl !== previewImageUrl ? previewImageUrl : null;
  const currentPlaceholderLabel =
    failedUrl && previewImageUrl === failedUrl ? '漫画画像を表示できません' : placeholderLabel;

  return (
    <span
      ref={observeRef}
      className={`entry-thumbnail ${className}`.trim()}
      aria-hidden={ariaHidden}
    >
      {imageUrl ? (
        <img
          className="entry-thumbnail-image"
          src={imageUrl}
          alt={alt}
          decoding="async"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <span
          className="entry-thumbnail-placeholder"
          role={!ariaHidden && currentPlaceholderLabel ? 'img' : undefined}
          aria-label={!ariaHidden ? currentPlaceholderLabel : undefined}
        >
          <Icon name="book" size={iconSize} />
        </span>
      )}
    </span>
  );
}
