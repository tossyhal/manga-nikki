import { useEffect, useRef, useState } from 'react';
import type { ComicDocument } from '../../../shared/schemas';
import { getAssetUrl } from '../../lib/api';
import { Comic } from './Comic';
import { ComicActions } from './ComicActions';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

type SavedComicProps = {
  comic: ComicDocument;
  hideTitle: boolean;
  generationId?: string;
};

export function SavedComic(props: SavedComicProps) {
  const ids =
    props.comic.visual.kind === 'page' ? [props.comic.visual.assetId] : props.comic.visual.assetIds;
  const key = JSON.stringify([props.generationId ?? null, props.comic.visual.kind, ids]);
  return <SavedComicContent key={key} {...props} />;
}

function SavedComicContent({ comic, hideTitle, generationId }: SavedComicProps) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [imageRequestedAt, setImageRequestedAt] = useState<Record<string, number>>({});
  const [imageRequestedAtWall, setImageRequestedAtWall] = useState<Record<string, number>>({});
  const [imageExpiresAt, setImageExpiresAt] = useState<Record<string, string>>({});
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
          const result = await getAssetUrl(id, reloadVersion > 0 ? { fresh: true } : undefined);
          if (active) {
            setImages((current) => ({ ...current, [id]: result.url }));
            setImageRequestedAt((current) => ({ ...current, [id]: result.requestedAt }));
            setImageRequestedAtWall((current) => ({ ...current, [id]: result.requestedAtWall }));
            setImageExpiresAt((current) => ({ ...current, [id]: result.expiresAt }));
            setFailedImageIds((current) => current.filter((failedId) => failedId !== id));
          }
        } catch {
          if (active) {
            setImages((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            setImageRequestedAt((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            setImageRequestedAtWall((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            setImageExpiresAt((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            setFailedImageIds((current) => (current.includes(id) ? current : [...current, id]));
          }
        }
      }),
    ).then(() => {
      if (!active) return;
      autoRenewing.current = false;
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
    setImageExpiresAt({});
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
        performance.now(),
        Date.now(),
        imageExpiresAt[id],
      )
    )
      return false;
    autoRenewAttempted.current = true;
    autoRenewing.current = true;
    setImages({});
    setImageRequestedAt({});
    setImageRequestedAtWall({});
    setImageExpiresAt({});
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
        hideTranscriptDisclosure
      />
      <ComicActions
        comic={comic}
        images={images}
        generationId={generationId}
        getFreshImages={async () => {
          const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
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
