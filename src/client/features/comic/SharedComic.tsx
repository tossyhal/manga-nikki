import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { comicSchema } from '../../../shared/schemas';
import { Comic } from './Comic';
import { ComicActions } from './ComicActions';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

const sharedComicSchema = z.object({
  comic: comicSchema,
  images: z.record(z.string(), z.string()),
});
type Shared = z.infer<typeof sharedComicSchema> & { requestedAt: number; requestedAtWall: number };

export function SharedComic() {
  const { token } = useParams();
  return <SharedComicContent key={token} token={token} />;
}

function SharedComicContent({ token }: { token: string | undefined }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [imageRefreshing, setImageRefreshing] = useState(false);
  const autoRenewAttempted = useRef(false);
  const autoRenewing = useRef(false);
  useEffect(() => {
    document.title = '共有された漫画 | 漫画日記';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow, noarchive';
    document.head.append(robots);
    return () => robots.remove();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('NOT_FOUND');
        const requestedAt = performance.now();
        const requestedAtWall = Date.now();
        const response = await fetch(`/api/v1/shared/${token}`, {
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (response.status === 404) throw new Error('NOT_FOUND');
        if (!response.ok) throw new Error('UNAVAILABLE');
        const result = sharedComicSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setData({ ...result, requestedAt, requestedAtWall });
          setImageRefreshing(false);
          autoRenewing.current = false;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          autoRenewing.current = false;
          setImageRefreshing(false);
          setError(
            error instanceof Error && error.message === 'NOT_FOUND'
              ? 'この漫画は見つからないか、共有が終了しています。'
              : '漫画を読み込めませんでした。時間をおいて再試行してください。',
          );
        }
      }
    })();
    return () => controller.abort();
  }, [token, version]);
  function reload() {
    autoRenewAttempted.current = false;
    autoRenewing.current = false;
    setImageRefreshing(false);
    setData(null);
    setError('');
    setVersion((v) => v + 1);
  }
  function renewExpiredImage(): boolean {
    if (autoRenewing.current) return true;
    if (
      !data ||
      !shouldRenewExpiredAsset(data.requestedAt, data.requestedAtWall, autoRenewAttempted.current)
    )
      return false;
    autoRenewAttempted.current = true;
    autoRenewing.current = true;
    setImageRefreshing(true);
    setVersion((v) => v + 1);
    return true;
  }
  return (
    <main className="shared-comic-page">
      <header>
        <Link to="/">漫画日記</Link>
        <span>共有された漫画</span>
      </header>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button className="button button-secondary" onClick={reload}>
            再読み込み
          </button>
        </div>
      ) : data ? (
        <>
          <h1>{data.comic.title}</h1>
          <Comic
            comic={data.comic}
            images={imageRefreshing ? {} : data.images}
            hideTitle
            onRetryImages={reload}
            onImageError={renewExpiredImage}
            imageLoading={imageRefreshing}
            imageRetrying={imageRefreshing}
            imageResetVersion={version}
          />
          <ComicActions
            comic={data.comic}
            images={data.images}
            getFreshImages={async () => {
              const response = await fetch(`/api/v1/shared/${token}`, {
                cache: 'no-store',
                credentials: 'omit',
              });
              if (!response.ok) throw new Error('SHARE_UNAVAILABLE');
              return sharedComicSchema.parse(await response.json()).images;
            }}
            ready={!imageRefreshing}
          />
        </>
      ) : (
        <output>漫画を読み込んでいます…</output>
      )}
    </main>
  );
}
