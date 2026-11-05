import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';
import { supabaseUrl, requiredKey, authOptions } from './supabase-config';

export function createServerStorageRemovalClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);

  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    ...(fetcher ? { global: { fetch: fetcher } } : {}),
  });
  const comics = client.storage.from('comics');
  return {
    remove: (paths: string[]) => comics.remove(paths),
    list: (path: string, options: { search: string; limit: number; offset: number }) =>
      comics.list(path, options),
  };
}
