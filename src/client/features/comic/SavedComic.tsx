import { useEffect, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { getAssetUrl } from '../../lib/api';
import { Comic } from './Comic';

export function SavedComic({ comic, hideTitle }: { comic: ComicDocument; hideTitle: boolean }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [failedImageIds, setFailedImageIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
    void Promise.all(
      ids.map(async (id) => {
        try {
          return { id, url: (await getAssetUrl(id)).url };
        } catch {
          return { id, url: null };
        }
      }),
    ).then((result) => {
      if (!active) return;
      setImages(
        Object.fromEntries(result.flatMap((image) => (image.url ? [[image.id, image.url]] : []))),
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
    setImages({});
    setFailedImageIds([]);
    setLoading(true);
    setReloadVersion((version) => version + 1);
  }

  return (
    <Comic
      key={reloadVersion}
      comic={comic}
      images={images}
      imageErrors={failedImageIds}
      imageLoading={loading}
      imageRetrying={loading}
      onRetryImages={retryImages}
      hideTitle={hideTitle}
    />
  );
}
