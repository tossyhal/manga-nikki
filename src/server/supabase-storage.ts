import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';
import { supabaseUrl, requiredKey, authOptions } from './supabase-config';

function createServerComicsBucket(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);
  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    ...(fetcher ? { global: { fetch: fetcher } } : {}),
  });
  return client.storage.from('comics');
}

export function createServerStorageRemovalClient(environment: Environment, fetcher?: typeof fetch) {
  const comics = createServerComicsBucket(environment, fetcher);
  return {
    remove: (paths: string[]) => comics.remove(paths),
    list: (path: string, options: { search: string; limit: number; offset: number }) =>
      comics.list(path, options),
  };
}

export function createServerComicStorageClient(environment: Environment, fetcher?: typeof fetch) {
  const comics = createServerComicsBucket(environment, fetcher);
  return {
    upload: (path: string, bytes: Uint8Array, mediaType: string) =>
      comics.upload(path, bytes, {
        contentType: mediaType,
        cacheControl: '0',
        upsert: true,
      }),
    download: (path: string, signal?: AbortSignal) =>
      comics.download(path, {}, { cache: 'no-store', ...(signal ? { signal } : {}) }),
  };
}

export function createServerAssetSigningClient(environment: Environment, fetcher?: typeof fetch) {
  const comics = createServerComicsBucket(environment, fetcher);
  return {
    createSignedUrl: (path: string, expiresIn: number) => comics.createSignedUrl(path, expiresIn),
  };
}
