import { createClient } from '@supabase/supabase-js';
import type { Environment } from './mode';
import { createSupabaseApiKeyFetch } from '../shared/supabase-fetch';

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
      fetch: createSupabaseApiKeyFetch(publishableKey, fetcher),
    },
  });
}

export function createServerRpcClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);
  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    global: { fetch: createSupabaseApiKeyFetch(secretKey, fetcher) },
  });
  return { rpc: client.rpc.bind(client) };
}

export function createServerAssetMetadataClient(environment: Environment, fetcher?: typeof fetch) {
  const secretKey = requiredKey(environment.SUPABASE_SECRET_KEY);
  const client = createClient(supabaseUrl(environment), secretKey, {
    auth: authOptions,
    global: { fetch: createSupabaseApiKeyFetch(secretKey, fetcher) },
  });
  return {
    getAsset: (assetId: string) =>
      client
        .from('assets')
        .select('id,generation_id,owner_id,object_path,media_type')
        .eq('id', assetId)
        .maybeSingle(),
    getAssets: (assetIds: string[]) =>
      client
        .from('assets')
        .select('id,generation_id,owner_id,object_path,media_type')
        .in('id', assetIds),
  };
}

export function expectedSupabaseIssuer(environment: Environment): string {
  return `${supabaseUrl(environment)}/auth/v1`;
}
