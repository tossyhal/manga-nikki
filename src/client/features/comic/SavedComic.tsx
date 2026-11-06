import { useEffect, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { getAssetUrl } from '../../lib/api';
import { Comic } from './Comic';
import { ComicActions } from './ComicActions';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

export function SavedComic({
  comic,
  hideTitle,
  generationId,
}: {
  comic: ComicDocument;
  hideTitle: boolean;
  generationId?: string;
}) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [imageRequestedAt, setImageRequestedAt] = useState<Record<string, number>>({});
  const [imageRequestedAtWall, setImageRequestedAtWall] = useState<Record<string, number>>({});
  const [failedImageIds, setFailedImageIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const autoRenewAttempted = useRef(false);
  const autoRenewing = useRef(false);
  useEffect(() => {
    autoRenewAttempted.current = false;
    autoRenewing.current = false;
  }, [comic]);
  useEffect(() => {
    let active = true;
    const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
    void Promise.all(
      ids.map(async (id) => {
        try {
          const requestedAt = performance.now();
          const requestedAtWall = Date.now();
          const result = await getAssetUrl(id);
          return { id, url: result.url, requestedAt, requestedAtWall };
        } catch {
          return { id, url: null, requestedAt: null, requestedAtWall: null };
        }
      }),
    ).then((result) => {
      if (!active) return;
      autoRenewing.current = false;
      setImages(
        Object.fromEntries(result.flatMap((image) => (image.url ? [[image.id, image.url]] : []))),
      );
      setImageRequestedAt(
        Object.fromEntries(
          result.flatMap((image) =>
            image.requestedAt !== null ? [[image.id, image.requestedAt]] : [],
          ),
        ),
      );
      setImageRequestedAtWall(
        Object.fromEntries(
          result.flatMap((image) =>
            image.requestedAtWall !== null ? [[image.id, image.requestedAtWall]] : [],
          ),
        ),
      );
      setFailedImageIds(result.filter((image) => image.url === null).map((image) => image.id));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [comic, reloadVersion]);

  function retryImages() {
    if (loading) return;
    autoRenewAttempted.current = false;
    autoRenewing.current = false;
    setImages({});
    setImageRequestedAt({});
    setImageRequestedAtWall({});
    setFailedImageIds([]);
    setLoading(true);
    setReloadVersion((version) => version + 1);
  }

  function handleImageError(id: string): boolean {
    if (autoRenewing.current) return true;
    if (
      !shouldRenewExpiredAsset(
        imageRequestedAt[id],
        imageRequestedAtWall[id],
        autoRenewAttempted.current,
      )
    )
      return false;
    autoRenewAttempted.current = true;
    autoRenewing.current = true;
    setImages({});
    setImageRequestedAt({});
    setImageRequestedAtWall({});
    setFailedImageIds([]);
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
      />
      <ComicActions
        comic={comic}
        images={images}
        generationId={generationId}
        getFreshImages={async () => {
          const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
          return Object.fromEntries(
            await Promise.all(ids.map(async (id) => [id, (await getAssetUrl(id)).url])),
          );
        }}
        ready={!loading && failedImageIds.length === 0}
      />
    </>
  );
}
