import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';

import {
  SupabaseConfigurationError,
  supabaseUrl,
  requiredKey,
  authOptions,
} from './supabase-config';
export { SupabaseConfigurationError } from './supabase-config';

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

export function createServerAssetMetadataClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);
  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    ...(fetcher ? { global: { fetch: fetcher } } : {}),
  });
  return {
    getAsset: (assetId: string) =>
      client
        .from('assets')
        .select('id,generation_id,owner_id,object_path,media_type')
        .eq('id', assetId)
        .maybeSingle(),
  };
}

export function expectedSupabaseIssuer(environment: Environment): string {
  return `${supabaseUrl(environment)}/auth/v1`;
}
