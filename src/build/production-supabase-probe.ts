import { randomUUID } from 'node:crypto';
import { PRODUCTION_SUPABASE_URL } from './public-config-guard.ts';
import { ProductionConnectedDeploymentFailure } from './production-connected-deployment.ts';

const MAX_RESPONSE_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new ProductionConnectedDeploymentFailure('SUPABASE_PROBE_FAILED');
}

function isLegacyServiceRoleJwt(value: string): boolean {
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'role' in payload &&
      payload.role === 'service_role'
    );
  } catch {
    return false;
  }
}

async function readResponseJson(response: Response): Promise<JsonRecord> {
  if (response.status !== 200) return fail();
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail();
      }
      chunks.push(value);
    }
  } catch {
    return fail();
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}

export type ProductionSupabaseProbeInput = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
}>;

export async function runProductionSupabaseConnectionProbe(
  input: ProductionSupabaseProbeInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (input.supabaseUrl !== PRODUCTION_SUPABASE_URL) return fail();
  try {
    const settingsResponse = await fetcher(`${PRODUCTION_SUPABASE_URL}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: input.publishableKey, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await readResponseJson(settingsResponse);

    const quotaHeaders: Record<string, string> = {
      apikey: input.secretKey,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (isLegacyServiceRoleJwt(input.secretKey)) {
      quotaHeaders.authorization = `Bearer ${input.secretKey}`;
    }
    const quotaResponse = await fetcher(
      `${PRODUCTION_SUPABASE_URL}/rest/v1/rpc/get_generation_quota`,
      {
        method: 'POST',
        headers: quotaHeaders,
        body: JSON.stringify({ p_actor_id: randomUUID() }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    const quota = await readResponseJson(quotaResponse);
    if (
      typeof quota.remaining_today !== 'number' ||
      !Number.isInteger(quota.remaining_today) ||
      quota.generation_available !== false ||
      typeof quota.profile_is_mock !== 'boolean' ||
      typeof quota.reset_at !== 'string' ||
      !(quota.active_generation_id === null || typeof quota.active_generation_id === 'string')
    ) {
      return fail();
    }
  } catch {
    return fail();
  }
}
