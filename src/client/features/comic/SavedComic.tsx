import { useEffect, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { getAssetUrl } from '../../lib/api';
import { Comic } from './Comic';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

export function SavedComic({ comic, hideTitle }: { comic: ComicDocument; hideTitle: boolean }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [imageReceivedAt, setImageReceivedAt] = useState<Record<string, number>>({});
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
          const result = await getAssetUrl(id);
          return { id, url: result.url, receivedAt: performance.now() };
        } catch {
          return { id, url: null, receivedAt: null };
        }
      }),
    ).then((result) => {
      if (!active) return;
      autoRenewing.current = false;
      setImages(
        Object.fromEntries(result.flatMap((image) => (image.url ? [[image.id, image.url]] : []))),
      );
      setImageReceivedAt(
        Object.fromEntries(
          result.flatMap((image) =>
            image.receivedAt !== null ? [[image.id, image.receivedAt]] : [],
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
    setImageReceivedAt({});
    setFailedImageIds([]);
    setLoading(true);
    setReloadVersion((version) => version + 1);
  }

  function handleImageError(id: string): boolean {
    if (autoRenewing.current) return true;
    if (!shouldRenewExpiredAsset(imageReceivedAt[id], autoRenewAttempted.current)) return false;
    autoRenewAttempted.current = true;
    autoRenewing.current = true;
    setImages({});
    setImageReceivedAt({});
    setFailedImageIds([]);
    setLoading(true);
    setReloadVersion((version) => version + 1);
    return true;
  }

  return (
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
  );
}
