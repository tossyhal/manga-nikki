import { z } from 'zod';

const clientConfigSchema = z.strictObject({
  generationAvailable: z.boolean(),
  dataMode: z.enum(['mock', 'live', 'sample']),
  consentVersion: z.literal('v1'),
  retentionDays: z.number().int().positive(),
});

export type ClientConfig = z.infer<typeof clientConfigSchema>;

let configPromise: Promise<ClientConfig> | null = null;

export function getClientConfig(): Promise<ClientConfig> {
  if (!configPromise) {
    configPromise = fetch('/api/v1/config', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
        const parsed = clientConfigSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('INVALID_CONFIG');
        return parsed.data;
      })
      .catch((error: unknown) => {
        configPromise = null;
        throw error;
      });
  }
  return configPromise;
}

export function invalidateClientConfig(): void {
  configPromise = null;
}
