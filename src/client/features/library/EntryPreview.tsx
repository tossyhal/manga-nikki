import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from 'react';
import type { Entry, EntryDetail, Generation } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';
import { getAssetUrl, getEntry, getGeneration } from '../../lib/api';
import {
  shouldRefreshExpiredAssetOnVisibility,
  shouldRenewExpiredAsset,
} from '../comic/signedAssetRefresh';

export type EntryPreviewOptions = { eager?: boolean };

export type EntryPreview = {
  imageUrl: string | null;
  imageToken: number | null;
  generation: Generation | null;
  comicGeneration: Generation | null;
  isStale: boolean;
  isLoading: boolean;
  error?: string;
  imageError?: string;
  observeRef: RefCallback<HTMLElement>;
  handleImageError: (url: string, token: number | null) => void;
  retryImage: () => void;
};

type PreviewResult = Omit<EntryPreview, 'observeRef' | 'handleImageError' | 'retryImage'> & {
  key: string | null;
};

function validGeneration(
  generation: Generation | null | undefined,
  entryId: string,
  revision: number,
): generation is Generation {
  return Boolean(
    generation &&
    generation.entryId === entryId &&
    generation.entryRevision <= revision &&
    generation.id,
  );
}

function lastSuccessfulGeneration(
  detail: EntryDetail,
  latest: Generation | null,
): Generation | null {
  if (latest?.id === detail.latestGenerationId && latest.status === 'succeeded') return latest;
  const successful = detail.lastSuccessfulGeneration;
  return validGeneration(successful, detail.id, detail.revision) &&
    successful.status === 'succeeded'
    ? successful
    : null;
}

export function useEntryPreview(
  entry: Entry | null,
  { eager = false }: EntryPreviewOptions = {},
): EntryPreview {
  const entryId = entry?.id ?? null;
  const revision = entry?.revision ?? null;
  const generationId = entry?.latestGenerationId ?? null;
  const key = entry ? `${entry.id}:${revision}:${generationId ?? 'draft'}` : null;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [observedVisible, setObservedVisible] = useState(false);
  const visible = eager || observedVisible;
  const visibleRef = useRef(visible);
  const refreshRef = useRef<(() => void) | null>(null);
  const imageErrorRef = useRef<((url: string, token: number | null) => void) | null>(null);
  const retryImageRef = useRef<(() => void) | null>(null);
  const [result, setResult] = useState<PreviewResult>({
    key: null,
    imageUrl: null,
    imageToken: null,
    generation: null,
    comicGeneration: null,
    isStale: false,
    isLoading: false,
  });
  const observeRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (!eager) {
        setTarget(node);
        if (!node) setObservedVisible(false);
      }
    },
    [eager],
  );
  const handleImageError = useCallback(
    (url: string, token: number | null) => imageErrorRef.current?.(url, token),
    [],
  );
  const retryImage = useCallback(() => retryImageRef.current?.(), []);

  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (eager || !target) return;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(
        ([observed]) => setObservedVisible(Boolean(observed?.isIntersecting)),
        { rootMargin: '80px' },
      );
      observer.observe(target);
      return () => observer.disconnect();
    }

    const updateVisibility = () => {
      if (window.innerHeight <= 0) return;
      const bounds = target.getBoundingClientRect();
      setObservedVisible(bounds.top < window.innerHeight + 80 && bounds.bottom > -80);
    };
    window.addEventListener('scroll', updateVisibility, { passive: true });
    window.addEventListener('resize', updateVisibility);
    updateVisibility();
    return () => {
      window.removeEventListener('scroll', updateVisibility);
      window.removeEventListener('resize', updateVisibility);
    };
  }, [eager, target]);

  useEffect(() => {
    if (visible) refreshRef.current?.();
  }, [key, visible]);

  useEffect(() => {
    let active = true;
    let fetching = false;
    let fetchingAsset = false;
    let initialized = false;
    let pollTimer: number | null = null;
    let activeGenerationId = generationId;
    let latestGeneration: Generation | null = null;
    let comicGeneration: Generation | null = null;
    let currentAsset: {
      url: string;
      expiresAt: string;
      requestedAt: number;
      requestedAtWall: number;
      token: number;
    } | null = null;
    let assetRequestId = 0;
    let autoRefreshAttempted = false;
    let imageFailureMessage = '漫画画像を表示できません。';

    if (!entryId || !generationId || revision === null) {
      imageErrorRef.current = null;
      retryImageRef.current = null;
      return () => {
        active = false;
      };
    }

    function publish(patch: Partial<Omit<PreviewResult, 'key'>>) {
      setResult((current) => ({
        ...(current.key === key
          ? current
          : {
              key,
              imageUrl: null,
              imageToken: null,
              generation: null,
              comicGeneration: null,
              isStale: false,
              isLoading: false,
            }),
        ...patch,
        key,
      }));
    }

    async function refreshComicImage(
      generation: Extract<Generation, { status: 'succeeded' }>,
      clearImage: boolean,
    ) {
      if (!active || fetchingAsset || comicGeneration?.id !== generation.id) return;
      fetchingAsset = true;
      const requestId = ++assetRequestId;
      const requestedAt = performance.now();
      const requestedAtWall = Date.now();
      if (clearImage) currentAsset = null;
      publish({
        ...(clearImage ? { imageUrl: null, imageToken: null } : {}),
        isLoading: true,
        imageError: undefined,
      });
      const assetId =
        generation.comic.visual.kind === 'page'
          ? generation.comic.visual.assetId
          : generation.comic.visual.assetIds[0];
      try {
        const asset = await getAssetUrl(assetId);
        if (active && assetRequestId === requestId && comicGeneration?.id === generation.id) {
          currentAsset = {
            url: asset.url,
            expiresAt: asset.expiresAt,
            requestedAt,
            requestedAtWall,
            token: requestId,
          };
          publish({
            imageUrl: asset.url,
            imageToken: requestId,
            isLoading: false,
            imageError: undefined,
          });
        }
      } catch {
        if (active && assetRequestId === requestId && comicGeneration?.id === generation.id) {
          if (clearImage) currentAsset = null;
          publish({
            ...(clearImage ? { imageUrl: null, imageToken: null } : {}),
            isLoading: false,
            imageError: imageFailureMessage,
          });
        }
      } finally {
        if (assetRequestId === requestId) fetchingAsset = false;
      }
    }

    async function loadComic(generation: Generation | null) {
      if (!active || !generation || generation.status !== 'succeeded') {
        comicGeneration = null;
        currentAsset = null;
        assetRequestId++;
        fetchingAsset = false;
        publish({
          comicGeneration: null,
          imageUrl: null,
          imageToken: null,
          isStale: false,
          isLoading: false,
          imageError: undefined,
        });
        return;
      }
      const previousComicId = comicGeneration?.id;
      if (previousComicId !== generation.id) autoRefreshAttempted = false;
      comicGeneration = generation;
      currentAsset = null;
      assetRequestId++;
      fetchingAsset = false;
      imageFailureMessage =
        previousComicId && previousComicId !== generation.id
          ? '新しい漫画画像を表示できません。'
          : '漫画画像を表示できません。';
      publish({
        comicGeneration: generation,
        imageUrl: null,
        imageToken: null,
        isStale: generation.entryRevision < revision!,
        isLoading: true,
        imageError: undefined,
      });
      await refreshComicImage(generation, true);
    }

    const handleComicImageError = (url: string, token: number | null) => {
      const asset = currentAsset;
      const comic = comicGeneration;
      if (
        !active ||
        token === null ||
        !asset ||
        asset.url !== url ||
        asset.token !== token ||
        !comic ||
        comic.status !== 'succeeded' ||
        fetchingAsset
      )
        return;

      const shouldRefresh = shouldRenewExpiredAsset(
        asset.requestedAt,
        asset.requestedAtWall,
        autoRefreshAttempted,
        performance.now(),
        Date.now(),
        asset.expiresAt,
      );
      currentAsset = null;
      if (shouldRefresh) {
        autoRefreshAttempted = true;
        void refreshComicImage(comic, true);
        return;
      }
      publish({
        imageUrl: null,
        imageToken: null,
        isLoading: false,
        imageError: imageFailureMessage,
      });
    };

    const retryComicImage = () => {
      const comic = comicGeneration;
      if (!active || !comic || comic.status !== 'succeeded' || fetchingAsset) return;
      autoRefreshAttempted = false;
      void refreshComicImage(comic, true);
    };

    imageErrorRef.current = handleComicImageError;
    retryImageRef.current = retryComicImage;

    function acceptLatest(generation: Generation) {
      if (!validGeneration(generation, entryId!, revision!) || generation.id !== activeGenerationId)
        return;
      latestGeneration = generation;
      publish({ generation, error: undefined });
      if (generation.status === 'succeeded') void loadComic(generation);
      if (generation.status === 'queued' || generation.status === 'running') schedulePolling();
      else if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function schedulePolling() {
      if (pollTimer === null) pollTimer = window.setInterval(() => void refresh(), 5000);
    }

    async function loadDetail() {
      if (initialized || fetching || !visibleRef.current || document.hidden) return;
      fetching = true;
      publish({ isLoading: true, error: undefined, imageError: undefined });
      try {
        const detail = await getEntry(entryId!);
        if (!active) return;
        if (detail.id !== entryId || detail.revision !== revision) {
          publish({
            isLoading: false,
            error: '記録が更新されています。状態を確認できません。',
          });
          initialized = true;
          return;
        }
        activeGenerationId = detail.latestGenerationId;
        const latest =
          validGeneration(detail.latestGeneration, entryId!, revision!) &&
          detail.latestGeneration.id === detail.latestGenerationId
            ? detail.latestGeneration
            : null;
        latestGeneration = latest;
        let latestUnavailable = false;
        if (detail.latestGenerationId && (!latest || latest.id !== detail.latestGenerationId)) {
          try {
            const current = await getGeneration(detail.latestGenerationId);
            if (
              active &&
              validGeneration(current, entryId!, revision!) &&
              current.id === detail.latestGenerationId
            ) {
              activeGenerationId = detail.latestGenerationId;
              latestGeneration = current;
            } else if (active) {
              latestUnavailable = true;
            }
          } catch {
            if (active) latestUnavailable = true;
          }
        }
        if (!active) return;
        const currentLatest = latestGeneration;
        const comic = lastSuccessfulGeneration(detail, currentLatest);
        comicGeneration = comic;
        publish({
          generation: currentLatest,
          comicGeneration: comic,
          imageUrl: null,
          imageToken: null,
          isStale: Boolean(comic && comic.entryRevision < revision!),
          isLoading: Boolean(comic),
          error: latestUnavailable ? '記録の状態を確認できません。' : undefined,
          imageError: undefined,
        });
        if (comic) await loadComic(comic);
        initialized = true;
        if (currentLatest?.status === 'queued' || currentLatest?.status === 'running') {
          schedulePolling();
        }
      } catch {
        if (active) {
          publish({
            generation: null,
            comicGeneration: null,
            imageUrl: null,
            imageToken: null,
            isStale: false,
            isLoading: false,
            error: '記録の状態を確認できません。',
            imageError: undefined,
          });
          initialized = true;
        }
      } finally {
        fetching = false;
      }
    }

    async function refresh() {
      if (!active || !visibleRef.current || document.hidden || fetching) return;
      if (!initialized) {
        await loadDetail();
        return;
      }
      if (
        !activeGenerationId ||
        !latestGeneration ||
        (latestGeneration.status !== 'queued' && latestGeneration.status !== 'running')
      )
        return;
      fetching = true;
      const polledGenerationId = activeGenerationId;
      try {
        const current = await getGeneration(polledGenerationId);
        if (!active || activeGenerationId !== polledGenerationId) return;
        if (!validGeneration(current, entryId!, revision!) || current.id !== polledGenerationId) {
          publish({ error: '記録の状態を確認できません。' });
          return;
        }
        acceptLatest(current);
      } catch {
        if (active && activeGenerationId === polledGenerationId)
          publish({ error: '記録の状態を確認できません。' });
      } finally {
        fetching = false;
      }
    }

    refreshRef.current = () => void refresh();
    if (visibleRef.current) void refresh();
    const onVisible = () => {
      if (document.hidden) return;
      void refresh();
      const asset = currentAsset;
      const comic = comicGeneration;
      if (
        !active ||
        !asset ||
        !comic ||
        comic.status !== 'succeeded' ||
        fetchingAsset ||
        !shouldRefreshExpiredAssetOnVisibility(
          asset.requestedAt,
          asset.requestedAtWall,
          autoRefreshAttempted,
          asset.expiresAt,
          performance.now(),
          Date.now(),
        )
      )
        return;
      autoRefreshAttempted = true;
      void refreshComicImage(comic, false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      if (pollTimer !== null) clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisible);
      if (refreshRef.current) refreshRef.current = null;
      if (imageErrorRef.current === handleComicImageError) imageErrorRef.current = null;
      if (retryImageRef.current === retryComicImage) retryImageRef.current = null;
    };
  }, [entryId, generationId, key, revision]);

  const current =
    result.key === key
      ? result
      : {
          key,
          imageUrl: null,
          imageToken: null,
          generation: null,
          comicGeneration: null,
          isStale: false,
          isLoading: Boolean(eager && entryId && generationId),
        };
  return { ...current, observeRef, handleImageError, retryImage };
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
  const { imageUrl, imageToken, observeRef } = preview;
  const currentPlaceholderLabel = preview.imageError
    ? '漫画画像を表示できません'
    : placeholderLabel;

  return (
    <span
      ref={observeRef}
      className={`entry-thumbnail ${className}`.trim()}
      aria-hidden={ariaHidden}
    >
      {imageUrl ? (
        <img
          key={imageToken ?? undefined}
          className="entry-thumbnail-image"
          src={imageUrl}
          alt={alt}
          decoding="async"
          onError={() => preview.handleImageError(imageUrl, imageToken)}
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
