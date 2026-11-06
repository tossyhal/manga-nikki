import { z } from 'zod';
import { comicSchema, type ComicDocument } from '../shared/schemas';
import { callGenerationRpc, type GenerationContext } from './live-generations';
import type { Environment } from './mode';
import { ApiError } from './http';
import { createServerAssetSigningClient } from './supabase-storage';
import { supabaseUrl } from './supabase-config';

export const shareTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const newShareToken = () =>
  crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export function toSharedComic(comic: ComicDocument): ComicDocument {
  // 描画指示のsceneには、画面の文章より詳しい日記由来の情報が含まれ得る。
  return comicSchema.parse({
    ...comic,
    panels: comic.panels.map((panel) => ({
      ...panel,
      scene: panel.caption || `${panel.index}コマ目`,
    })),
  });
}

export async function createComicShare(context: GenerationContext, generationId: string) {
  const token = await callGenerationRpc(
    context.environment,
    context.fetcher,
    'create_comic_share',
    {
      p_actor_id: context.owner,
      p_generation_id: z.uuid().parse(generationId),
      p_token: newShareToken(),
    },
  );
  return shareTokenSchema.parse(token);
}

const sharedRow = z.object({
  comic: comicSchema,
  is_mock: z.boolean(),
  assets: z.array(
    z.object({
      id: z.uuid(),
      owner_id: z.uuid(),
      generation_id: z.uuid(),
      object_path: z.string(),
      media_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    }),
  ),
});

export async function readComicShare(
  environment: Environment,
  token: string,
  fetcher?: typeof fetch,
) {
  const value = await callGenerationRpc(environment, fetcher, 'read_comic_share', {
    p_token: token,
  });
  if (value === null) throw new ApiError(404, 'NOT_FOUND');
  const parsed = sharedRow.safeParse(value);
  if (!parsed.success) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
  const { comic, is_mock, assets } = parsed.data;
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  const images = await Promise.all(
    ids.map(async (id) => {
      if (is_mock) return [id, '/sample-comic.svg'];
      const asset = assets.find((a) => a.id === id);
      if (!asset) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
      const extension = asset.media_type === 'image/jpeg' ? 'jpg' : asset.media_type.slice(6);
      const expected =
        `${asset.owner_id}/${asset.generation_id}/${asset.id}.${extension}`.toLowerCase();
      if (asset.object_path !== expected) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
      const { data, error } = await createServerAssetSigningClient(
        environment,
        fetcher,
      ).createSignedUrl(expected, 60);
      if (error || !data?.signedUrl) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
      const signedUrl = new URL(data.signedUrl);
      if (
        signedUrl.origin !== new URL(supabaseUrl(environment)).origin ||
        signedUrl.username ||
        signedUrl.password ||
        signedUrl.hash ||
        !signedUrl.pathname.startsWith('/storage/v1/object/sign/comics/')
      )
        throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
      return [id, signedUrl.toString()];
    }),
  );
  // 署名の取得中に削除・失効していた場合、新しいURLを公開しない。
  const current = await callGenerationRpc(environment, fetcher, 'read_comic_share', {
    p_token: token,
  });
  if (current === null) throw new ApiError(404, 'NOT_FOUND');
  if (JSON.stringify(current) !== JSON.stringify(value))
    throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
  return {
    comic: toSharedComic(comic),
    images: Object.fromEntries(images) as Record<string, string>,
  };
}
