import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';
import { SupabaseConfigurationError } from './supabase-clients';

const authOptions = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
};

function storageUrl(environment: Environment): string {
  const value = environment.SUPABASE_URL?.trim();
  if (!value) throw new SupabaseConfigurationError();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SupabaseConfigurationError();
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHosts.has(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new SupabaseConfigurationError();

  return url.origin;
}

export function createServerStorageRemovalClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey) throw new SupabaseConfigurationError();

  const client = createClient(storageUrl(environment), secretKey, {
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
