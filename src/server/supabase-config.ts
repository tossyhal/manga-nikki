import type { Environment } from './mode';

export class SupabaseConfigurationError extends Error {
  constructor() {
    super('SUPABASE_CONFIGURATION_INVALID');
  }
}

export function supabaseUrl(environment: Environment): string {
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

export function requiredKey(value: string | undefined): string {
  if (!value?.trim()) throw new SupabaseConfigurationError();
  return value.trim();
}

export const authOptions = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
};
