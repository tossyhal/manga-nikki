import type { Page } from '@playwright/test';
import type { ComicDocument } from '../../src/shared/schemas';

export const comicAssetExpiry = '2099-01-01T00:00:00Z';

export function comicAssetIds(comic: ComicDocument): string[] {
  return comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
}

export function comicAssetPayload(
  comic: ComicDocument,
  urlFor: (assetId: string, index: number) => string = (assetId) =>
    `/sample-comic.svg?asset=${assetId}`,
  expiresAt = comicAssetExpiry,
) {
  return {
    assets: comicAssetIds(comic).map((id, index) => ({
      id,
      url: urlFor(id, index),
      expiresAt,
    })),
  };
}

export async function routeComicAssets(
  page: Page,
  generationId: string,
  comic: () => ComicDocument,
  urlFor?: (assetId: string, index: number) => string,
  expiresAt = comicAssetExpiry,
) {
  await page.route(`**/api/v1/generations/${generationId}/assets`, (route) =>
    route.fulfill({ json: comicAssetPayload(comic(), urlFor, expiresAt) }),
  );
  await page.route('**/sample-comic.svg?asset=*', (route) => {
    const assetId = new URL(route.request().url()).searchParams.get('asset') ?? '';
    return route.fulfill(comicImageFixture(assetId));
  });
}

export function comicImageFixture(assetId: string, width = 10, height = 10) {
  return {
    contentType: 'image/svg+xml',
    headers: { 'cache-control': 'no-store' },
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" data-asset-id="${assetId}"><title>${assetId}</title><rect width="${width}" height="${height}"/></svg>`,
  };
}
