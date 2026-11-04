import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';

export class SupabaseConfigurationError extends Error {
  constructor() {
    super('SUPABASE_CONFIGURATION_INVALID');
  }
}

function supabaseUrl(environment: Environment): string {
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

function requiredKey(value: string | undefined): string {
  if (!value?.trim()) throw new SupabaseConfigurationError();
  return value.trim();
}

const authOptions = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
};

export function createUserSupabaseClient(
  environment: Environment,
  accessToken: string,
  fetcher?: typeof fetch,
) {
  if (!accessToken) throw new SupabaseConfigurationError();
  const publishableKey = requiredKey(environment.SUPABASE_PUBLISHABLE_KEY);
  return createClient(supabaseUrl(environment), publishableKey, {
    auth: authOptions,
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(fetcher ? { fetch: fetcher } : {}),
    },
  });
}

export function createServerRpcClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);
  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    ...(fetcher ? { global: { fetch: fetcher } } : {}),
  });
  return { rpc: client.rpc.bind(client) };
}

export function expectedSupabaseIssuer(environment: Environment): string {
  return `${supabaseUrl(environment)}/auth/v1`;
}
