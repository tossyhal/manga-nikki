import { z } from 'zod';

const clientConfigSchema = z.strictObject({
  generationAvailable: z.boolean(),
  dataMode: z.enum(['mock', 'live', 'sample']),
  consentVersion: z.literal('v1'),
  retentionDays: z.number().int().positive(),
});

export type ClientConfig = z.infer<typeof clientConfigSchema>;

let configPromise: Promise<ClientConfig> | null = null;
let lastGoodConfig: ClientConfig | null = null;
let latestRequestId = 0;
let latestRequestPromise: Promise<ClientConfig> | null = null;
let refreshPromise: Promise<ClientConfig> | null = null;

function sameConfig(left: ClientConfig, right: ClientConfig): boolean {
  return (
    left.generationAvailable === right.generationAvailable &&
    left.dataMode === right.dataMode &&
    left.consentVersion === right.consentVersion &&
    left.retentionDays === right.retentionDays
  );
}

async function requestConfig(): Promise<ClientConfig> {
  const response = await fetch('/api/v1/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
  const parsed = clientConfigSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('INVALID_CONFIG');
  return parsed.data;
}

function startConfigRequest(): Promise<ClientConfig> {
  const requestId = ++latestRequestId;
  let request: Promise<ClientConfig>;
  request = requestConfig()
    .then((config) => {
      if (requestId !== latestRequestId) {
        return latestRequestPromise ?? lastGoodConfig ?? config;
      }
      const nextConfig =
        lastGoodConfig && sameConfig(lastGoodConfig, config) ? lastGoodConfig : config;
      lastGoodConfig = nextConfig;
      configPromise = Promise.resolve(nextConfig);
      return nextConfig;
    })
    .catch((error: unknown) => {
      if (requestId !== latestRequestId) {
        return latestRequestPromise ?? lastGoodConfig ?? Promise.reject(error);
      }
      configPromise = lastGoodConfig ? Promise.resolve(lastGoodConfig) : null;
      throw error;
    });
  latestRequestPromise = request;
  configPromise = request;
  return request;
}

export function getClientConfig(): Promise<ClientConfig> {
  if (refreshPromise) return refreshPromise;
  if (!configPromise) configPromise = startConfigRequest();
  return configPromise;
}

export function refreshClientConfig(): Promise<ClientConfig> {
  if (refreshPromise) return refreshPromise;
  const request = startConfigRequest();
  let refresh: Promise<ClientConfig>;
  refresh = request.finally(() => {
    if (refreshPromise === refresh) refreshPromise = null;
  });
  refreshPromise = refresh;
  latestRequestPromise = refresh;
  configPromise = refresh;
  return refresh;
}

export function invalidateClientConfig(): void {
  configPromise = null;
  lastGoodConfig = null;
  latestRequestId++;
  latestRequestPromise = null;
  refreshPromise = null;
}
