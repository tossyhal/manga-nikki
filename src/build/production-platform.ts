import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { createSupabaseApiKeyFetch } from '../shared/supabase-fetch.ts';
import { PRODUCTION_SUPABASE_URL } from './public-config-guard.ts';
import { checkProductionSamplePreflight } from './production-sample-preflight.ts';

export const PRODUCTION_PLATFORM = {
  accountId: 'c9cee9599752cb191815c0eea6ff457e',
  workerName: 'manga-nikki',
  queueName: 'manga-nikki-generations-production',
  bucketName: 'comics',
  fileSizeLimit: 8 * 1024 * 1024,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
} as const;

// 公開の参照ID。秘密値はBitwarden Actionだけから取得する。
export const PRODUCTION_PLATFORM_SECRET_IDS = Object.freeze({
  cloudflare: '21eb9e78-19d2-42ed-a48d-b4fa00afac2f',
  publishable: '5a234d12-0da3-4e68-99df-b4f90120a095',
  server: '31bfdcfa-5643-454d-b136-b4f901208fb0',
});

export type PlatformOperation = 'check' | 'setup' | 'probe-storage';
type PlatformCode =
  | 'PLATFORM_INPUT_INVALID'
  | 'PLATFORM_MAIN_STALE'
  | 'PLATFORM_REQUEST_FAILED'
  | 'PLATFORM_RESPONSE_INVALID'
  | 'QUEUE_PERMISSION_REQUIRED'
  | 'QUEUE_MISSING'
  | 'QUEUE_INVALID'
  | 'STORAGE_MISSING'
  | 'STORAGE_CONFIG_INVALID'
  | 'STORAGE_REQUEST_FAILED'
  | 'STORAGE_PROBE_FAILED'
  | 'STORAGE_CLEANUP_FAILED';
export class ProductionPlatformFailure extends Error {
  readonly code: PlatformCode;
  constructor(code: PlatformCode) {
    super(code);
    this.code = code;
    this.name = 'ProductionPlatformFailure';
  }
}
function fail(code: PlatformCode): never {
  throw new ProductionPlatformFailure(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function secret(value: string | undefined): string {
  if (
    !value ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  ) {
    return fail('PLATFORM_INPUT_INVALID');
  }
  return value;
}

export async function gateProductionPlatform(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): Promise<PlatformOperation> {
  const operation = env.PRODUCTION_PLATFORM_OPERATION;
  if (
    !['check', 'setup', 'probe-storage'].includes(operation ?? '') ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    (operation !== 'check' &&
      (env.PRODUCTION_PLATFORM_CONFIRMATION !== PRODUCTION_PLATFORM.queueName ||
        env.GITHUB_RUN_ATTEMPT !== '1'))
  ) {
    return fail('PLATFORM_INPUT_INVALID');
  }
  const result = await checkProductionSamplePreflight(
    {
      githubActions: env.GITHUB_ACTIONS,
      githubRepository: env.GITHUB_REPOSITORY,
      githubRef: env.GITHUB_REF,
      githubEventName: env.GITHUB_EVENT_NAME,
      githubSha: env.GITHUB_SHA,
      githubActorId: env.GITHUB_ACTOR_ID,
      githubTriggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      githubToken: env.GITHUB_TOKEN,
      workerUrl: 'https://manga-nikki.tossyhal.workers.dev',
      productionSampleCdEnabled: 'true',
      bwsCloudflareSecretId: env.BWS_CLOUDFLARE_SECRET_ID,
    },
    { githubFetcher: fetcher },
  );
  if (result.deployment !== 'ready') return fail('PLATFORM_MAIN_STALE');
  if (
    env.BWS_CLOUDFLARE_SECRET_ID !== PRODUCTION_PLATFORM_SECRET_IDS.cloudflare ||
    env.BWS_SUPABASE_PUBLISHABLE_KEY_SECRET_ID !== PRODUCTION_PLATFORM_SECRET_IDS.publishable ||
    env.BWS_SUPABASE_SECRET_KEY_SECRET_ID !== PRODUCTION_PLATFORM_SECRET_IDS.server
  )
    return fail('PLATFORM_INPUT_INVALID');
  return operation as PlatformOperation;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return fail('PLATFORM_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        return fail('PLATFORM_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return fail('PLATFORM_RESPONSE_INVALID');
  } finally {
    reader.releaseLock();
  }
}

export type ProductionPlatformInput = Readonly<{
  operation: PlatformOperation;
  cloudflareToken: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
}>;
export type ProductionPlatformResult = Readonly<{
  queue: 'present' | 'created' | 'missing' | 'permission-required';
  bucket: 'private-present' | 'private-created';
  cron: 'daily-only' | 'generation-and-daily' | 'unexpected';
  storageProbe: 'passed' | 'not-run';
  storagePolicies: 'requires-database-verification';
}>;

export async function runProductionPlatform(
  input: ProductionPlatformInput,
  fetcher: typeof fetch = fetch,
): Promise<ProductionPlatformResult> {
  const cfToken = secret(input.cloudflareToken);
  const serverKey = secret(input.supabaseSecretKey);
  const publicKey = secret(input.supabasePublishableKey);
  if (!['check', 'setup', 'probe-storage'].includes(input.operation)) {
    return fail('PLATFORM_INPUT_INVALID');
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_PLATFORM.accountId}`;
  const cfRequest = async (path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return fail('PLATFORM_REQUEST_FAILED');
    }
    if (response.status === 401 || response.status === 403) {
      return fail('QUEUE_PERMISSION_REQUIRED');
    }
    if (!response.ok) return fail('PLATFORM_REQUEST_FAILED');
    const json = await boundedJson(response);
    if (!record(json) || json.success !== true) return fail('PLATFORM_RESPONSE_INVALID');
    return json.result;
  };
  let queue: ProductionPlatformResult['queue'] = 'present';
  try {
    const queues = await cfRequest(`/queues?name=${PRODUCTION_PLATFORM.queueName}&per_page=100`);
    if (!Array.isArray(queues)) return fail('PLATFORM_RESPONSE_INVALID');
    const matches = queues.filter(
      (item) => record(item) && item.queue_name === PRODUCTION_PLATFORM.queueName,
    );
    if (matches.length > 1) return fail('QUEUE_INVALID');
    if (matches.length === 0) {
      queue = 'missing';
      if (input.operation === 'setup') {
        const created = await cfRequest('/queues', { queue_name: PRODUCTION_PLATFORM.queueName });
        if (!record(created) || created.queue_name !== PRODUCTION_PLATFORM.queueName)
          return fail('QUEUE_INVALID');
        queue = 'created';
      }
    }
  } catch (error) {
    if (!(error instanceof ProductionPlatformFailure) || error.code !== 'QUEUE_PERMISSION_REQUIRED')
      throw error;
    queue = 'permission-required';
  }
  const schedules = await cfRequest(`/workers/scripts/${PRODUCTION_PLATFORM.workerName}/schedules`);
  if (!record(schedules) || !Array.isArray(schedules.schedules))
    return fail('PLATFORM_RESPONSE_INVALID');
  const crons = schedules.schedules
    .map((schedule: unknown) => (record(schedule) ? schedule.cron : undefined))
    .sort();
  const cron =
    JSON.stringify(crons) === JSON.stringify(['0 15 * * *'])
      ? 'daily-only'
      : JSON.stringify(crons) === JSON.stringify(['* * * * *', '0 15 * * *'])
        ? 'generation-and-daily'
        : 'unexpected';

  const safeFetch: typeof fetch = async (url, init) => {
    if (typeof url !== 'string' || new URL(url).origin !== PRODUCTION_SUPABASE_URL)
      return fail('PLATFORM_INPUT_INVALID');
    const timeout = AbortSignal.timeout(15_000);
    return fetcher(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: safeFetch },
  };
  const admin = createClient(PRODUCTION_SUPABASE_URL, serverKey, {
    ...options,
    global: { fetch: createSupabaseApiKeyFetch(serverKey, safeFetch) },
  });
  let bucket: ProductionPlatformResult['bucket'] = 'private-present';
  try {
    const existing = await admin.storage.getBucket('comics');
    if (existing.error) {
      if (
        !['404', '400'].includes(String(existing.error.statusCode)) ||
        existing.error.message !== 'Bucket not found'
      ) {
        return fail('STORAGE_REQUEST_FAILED');
      }
      if (input.operation !== 'setup') return fail('STORAGE_MISSING');
      const created = await admin.storage.createBucket('comics', {
        public: false,
        fileSizeLimit: PRODUCTION_PLATFORM.fileSizeLimit,
        allowedMimeTypes: [...PRODUCTION_PLATFORM.allowedMimeTypes],
      });
      if (created.error) return fail('STORAGE_REQUEST_FAILED');
      bucket = 'private-created';
    }
    const checked = await admin.storage.getBucket('comics');
    const actual = checked.data;
    if (
      checked.error ||
      !actual ||
      actual.id !== 'comics' ||
      actual.name !== 'comics' ||
      actual.public !== false ||
      actual.file_size_limit !== PRODUCTION_PLATFORM.fileSizeLimit ||
      JSON.stringify([...(actual.allowed_mime_types ?? [])].sort()) !==
        JSON.stringify([...PRODUCTION_PLATFORM.allowedMimeTypes].sort())
    ) {
      return fail('STORAGE_CONFIG_INVALID');
    }
    if (input.operation === 'probe-storage') {
      await probeStorage(
        admin,
        publicKey,
        { ...options, global: { fetch: createSupabaseApiKeyFetch(publicKey, safeFetch) } },
        safeFetch,
      );
    }
  } catch (error) {
    if (error instanceof ProductionPlatformFailure) throw error;
    return fail('STORAGE_REQUEST_FAILED');
  }
  return {
    queue,
    bucket,
    cron,
    storageProbe: input.operation === 'probe-storage' ? 'passed' : 'not-run',
    storagePolicies: 'requires-database-verification',
  };
}

async function probeStorage(
  admin: SupabaseClient,
  publicKey: string,
  options: Parameters<typeof createClient>[2],
  fetcher: typeof fetch,
): Promise<void> {
  const users: string[] = [];
  const paths: string[] = [];
  const run = randomUUID();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YoAAAAASUVORK5CYII=',
    'base64',
  );
  let cleanupFailed = false;
  try {
    const clients: SupabaseClient[] = [createClient(PRODUCTION_SUPABASE_URL, publicKey, options)];
    for (let index = 0; index < 2; index++) {
      const email = `platform-${run}-${index}@example.invalid`;
      const created = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (
        created.error ||
        !created.data.user ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          created.data.user.id,
        ) ||
        created.data.user.email !== email
      )
        return fail('STORAGE_PROBE_FAILED');
      users.push(created.data.user.id);
      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      if (link.error || !link.data.properties.hashed_token) return fail('STORAGE_PROBE_FAILED');
      const client = createClient(PRODUCTION_SUPABASE_URL, publicKey, options);
      const session = await client.auth.verifyOtp({
        token_hash: link.data.properties.hashed_token,
        type: 'magiclink',
      });
      if (session.error || session.data.user?.id !== created.data.user.id || !session.data.session)
        return fail('STORAGE_PROBE_FAILED');
      clients.push(client);
    }
    const path = `${users[0]}/${run}/probe.png`;
    paths.push(path);
    const uploaded = await admin.storage
      .from('comics')
      .upload(path, png, { contentType: 'image/png', upsert: false });
    if (uploaded.error) return fail('STORAGE_PROBE_FAILED');
    const downloaded = await admin.storage.from('comics').download(path);
    if (
      downloaded.error ||
      !downloaded.data ||
      !Buffer.from(await downloaded.data.arrayBuffer()).equals(png)
    )
      return fail('STORAGE_PROBE_FAILED');
    const publicResponse = await fetcher(
      `${PRODUCTION_SUPABASE_URL}/storage/v1/object/public/comics/${path}`,
      { redirect: 'error' },
    );
    if (![400, 401, 403, 404].includes(publicResponse.status)) return fail('STORAGE_PROBE_FAILED');
    for (const [index, client] of clients.entries()) {
      const storage = client.storage.from('comics');
      const list = await storage.list(`${users[0]}/${run}`);
      if (
        list.error
          ? ![400, 401, 403].includes(Number(list.error.statusCode))
          : !Array.isArray(list.data) || list.data.length !== 0
      )
        return fail('STORAGE_PROBE_FAILED');
      const read = await storage.download(path);
      const signed = await storage.createSignedUrl(path, 60);
      const writePath = `${index === 2 ? users[1] : users[0]}/${run}/denied-${index}.png`;
      paths.push(writePath);
      const write = await storage.upload(writePath, png, {
        contentType: 'image/png',
        upsert: false,
      });
      for (const result of [read, signed, write]) {
        if (!result.error || ![400, 401, 403, 404].includes(Number(result.error.statusCode)))
          return fail('STORAGE_PROBE_FAILED');
      }
      // 公開化リクエストは送信せず、read-only SQLでbucket管理policyを別途検証する。
    }
  } finally {
    if (paths.length > 0) {
      try {
        const removed = await admin.storage.from('comics').remove(paths);
        if (removed.error) cleanupFailed = true;
        for (const owner of users) {
          const remaining = await admin.storage.from('comics').list(`${owner}/${run}`);
          if (remaining.error || !remaining.data || remaining.data.length !== 0)
            cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      }
    }
    for (const id of users) {
      try {
        const removed = await admin.auth.admin.deleteUser(id);
        if (removed.error) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail('STORAGE_CLEANUP_FAILED');
  }
}
