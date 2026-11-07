import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import {
  getAssetReadCacheEpoch,
  subscribeAssetReadCacheInvalidation,
} from '../../lib/api/assetReadCacheInvalidation';
import { getAssetUrl, getGenerationAssetUrls } from '../../lib/api';
import { ComicImageGrantExpiredError, type ComicImageLease } from '../../lib/api/comicImageMemory';
import { Comic } from './Comic';
import { ComicActions } from './ComicActions';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

type SavedComicProps = {
  comic: ComicDocument;
  hideTitle: boolean;
  generationId?: string;
};

function assetIds(comic: ComicDocument): string[] {
  return comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
}

export function SavedComic(props: SavedComicProps) {
  const ids = assetIds(props.comic);
  const key = JSON.stringify([props.generationId ?? null, props.comic.visual.kind, ids]);
  return <SavedComicContent key={key} {...props} />;
}

function SavedComicContent({ comic, hideTitle, generationId }: SavedComicProps) {
  const ids = useMemo(() => assetIds(comic), [comic]);
  const leases = useRef(new Map<string, ComicImageLease>());
  const loadingRef = useRef(true);
  const [images, setImages] = useState<Record<string, string>>({});
  const [imageRequestedAt, setImageRequestedAt] = useState<Record<string, number>>({});
  const [imageRequestedAtWall, setImageRequestedAtWall] = useState<Record<string, number>>({});
  const [imageExpiresAt, setImageExpiresAt] = useState<Record<string, string>>({});
  const [failedImageIds, setFailedImageIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [authScopeVersion, setAuthScopeVersion] = useState(0);
  const [mutationReloadVersion, setMutationReloadVersion] = useState(0);
  const autoRenewAttempted = useRef(false);
  const autoRenewing = useRef(false);

  const releaseImages = useCallback((invalidate = false) => {
    for (const lease of leases.current.values()) {
      if (invalidate) lease.invalidate();
      lease.release();
    }
    leases.current.clear();
  }, []);

  useEffect(() => {
    return subscribeAssetReadCacheInvalidation(({ reason }) => {
      if (reason === 'mutation') return;
      if (reason === 'mutation-finish') {
        if (loadingRef.current) setMutationReloadVersion((version) => version + 1);
        return;
      }
      releaseImages();
      setImages({});
      setImageRequestedAt({});
      setImageRequestedAtWall({});
      setImageExpiresAt({});
      if (reason === 'auth-scope-change') {
        loadingRef.current = true;
        setLoading(true);
        setFailedImageIds([]);
        setAuthScopeVersion((version) => version + 1);
      } else {
        loadingRef.current = false;
        setLoading(false);
        setFailedImageIds(ids);
      }
    });
  }, [ids, releaseImages]);

  useEffect(() => {
    autoRenewAttempted.current = false;
    autoRenewing.current = false;
  }, [comic]);

  useEffect(() => {
    let active = true;
    let loadingImages = false;
    let requestEpoch = getAssetReadCacheEpoch();

    function clearLocalImages() {
      releaseImages();
      setImages({});
      setImageRequestedAt({});
      setImageRequestedAtWall({});
      setImageExpiresAt({});
    }

    async function loadImages(fresh: boolean) {
      if (!active || loadingImages) return;
      loadingImages = true;
      requestEpoch = getAssetReadCacheEpoch();
      loadingRef.current = true;
      setLoading(true);
      try {
        const batch = generationId
          ? await getGenerationAssetUrls(generationId, fresh ? { fresh: true } : undefined)
          : null;
        const grantById = new Map(batch?.assets.map((asset) => [asset.id, asset]) ?? []);
        let retryWithFreshGrant = false;
        await Promise.all(
          ids.map(async (id) => {
            try {
              const grant = grantById.get(id);
              if (generationId && (!batch || !grant)) throw new Error('Comic image grant missing.');
              const metadata =
                grant ?? (await getAssetUrl(id, fresh ? { fresh: true } : undefined));
              const result = batch
                ? await batch.loadImage(id)
                : {
                    url: metadata.url,
                    cached: false,
                    invalidate: () => {},
                    release: () => {},
                  };
              if (!active || requestEpoch !== getAssetReadCacheEpoch()) {
                result.release();
                return;
              }
              const previous = leases.current.get(id);
              leases.current.set(id, result);
              previous?.release();
              setImages((current) => ({ ...current, [id]: result.url }));
              setImageRequestedAt((current) => ({ ...current, [id]: metadata.requestedAt }));
              setImageRequestedAtWall((current) => ({
                ...current,
                [id]: metadata.requestedAtWall,
              }));
              setImageExpiresAt((current) => ({ ...current, [id]: metadata.expiresAt }));
              setFailedImageIds((current) => current.filter((failedId) => failedId !== id));
            } catch (error) {
              if (!active || requestEpoch !== getAssetReadCacheEpoch()) return;
              if (error instanceof ComicImageGrantExpiredError) {
                if (!autoRenewAttempted.current) {
                  autoRenewAttempted.current = true;
                  retryWithFreshGrant = true;
                } else {
                  setFailedImageIds((current) =>
                    current.includes(id) ? current : [...current, id],
                  );
                }
                return;
              }
              setImages((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
              setFailedImageIds((current) => (current.includes(id) ? current : [...current, id]));
            }
          }),
        );
        if (active && requestEpoch === getAssetReadCacheEpoch()) {
          if (retryWithFreshGrant) {
            window.setTimeout(() => {
              if (!active) return;
              clearLocalImages();
              void loadImages(true);
            }, 0);
            return;
          }
          autoRenewing.current = false;
          loadingRef.current = false;
          setLoading(false);
        }
      } catch {
        if (active && requestEpoch === getAssetReadCacheEpoch()) {
          setFailedImageIds(ids);
          loadingRef.current = false;
          setLoading(false);
        }
      } finally {
        loadingImages = false;
      }
    }

    if (reloadVersion > 0 || mutationReloadVersion > 0) clearLocalImages();
    void loadImages(reloadVersion > 0);
    return () => {
      active = false;
      releaseImages();
    };
  }, [
    comic,
    generationId,
    ids,
    reloadVersion,
    authScopeVersion,
    mutationReloadVersion,
    releaseImages,
  ]);

  function retryImages() {
    if (loading) return;
    autoRenewAttempted.current = false;
    autoRenewing.current = false;
    releaseImages(true);
    setImages({});
    setImageRequestedAt({});
    setImageRequestedAtWall({});
    setImageExpiresAt({});
    setFailedImageIds([]);
    loadingRef.current = true;
    setLoading(true);
    setReloadVersion((version) => version + 1);
  }

  function handleImageError(id: string): boolean {
    if (autoRenewing.current) return true;
    const lease = leases.current.get(id);
    lease?.invalidate();
    if (
      !shouldRenewExpiredAsset(
        imageRequestedAt[id],
        imageRequestedAtWall[id],
        autoRenewAttempted.current,
        performance.now(),
        Date.now(),
        imageExpiresAt[id],
      )
    ) {
      lease?.release();
      leases.current.delete(id);
      setFailedImageIds((current) => (current.includes(id) ? current : [...current, id]));
      return false;
    }
    autoRenewAttempted.current = true;
    autoRenewing.current = true;
    lease?.release();
    leases.current.delete(id);
    setImages((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setFailedImageIds([]);
    loadingRef.current = true;
    setLoading(true);
    setReloadVersion((version) => version + 1);
    return true;
  }

  return (
    <>
      <Comic
        comic={comic}
        images={images}
        imageErrors={failedImageIds}
        imageLoading={loading}
        imageRetrying={loading}
        imageResetVersion={reloadVersion}
        onRetryImages={retryImages}
        onImageError={handleImageError}
        hideTitle={hideTitle}
        hideTranscriptDisclosure
      />
      <ComicActions
        comic={comic}
        images={images}
        generationId={generationId}
        getFreshImages={async () => {
          if (generationId) {
            const batch = await getGenerationAssetUrls(generationId, { fresh: true });
            return Object.fromEntries(batch.assets.map(({ id, url }) => [id, url]));
          }
          return Object.fromEntries(
            await Promise.all(
              ids.map(async (id) => [id, (await getAssetUrl(id, { fresh: true })).url]),
            ),
          );
        }}
        ready={!loading && failedImageIds.length === 0}
      />
    </>
  );
}
