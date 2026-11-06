import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertNoKnownServerKeyFormats,
  assertProductionPublicConfiguration,
  PRODUCTION_SUPABASE_URL,
  PRODUCTION_WORKER_HOSTNAME,
} from './public-config-guard.ts';
import { PRODUCTION_SAMPLE_PROFILE, type SampleDeploymentProfile } from './sample-deployment.ts';

export const PRODUCTION_CONNECTED_PROFILE: SampleDeploymentProfile<'production'> = Object.freeze({
  ...PRODUCTION_SAMPLE_PROFILE,
  dataMode: 'live',
  aiMode: 'live',
  crons: ['0 15 * * *'],
  requiredSecretBindings: ['SUPABASE_SECRET_KEY', 'TURNSTILE_SECRET_KEY'],
  connected: true,
});

export const PRODUCTION_GENERATION_QUEUE = 'manga-nikki-generations-production';

export function selectProductionConnectedProfile(
  infrastructureEnabled?: string,
  generationEnabled?: string,
): SampleDeploymentProfile<'production'> {
  if (infrastructureEnabled && !['true', 'false'].includes(infrastructureEnabled)) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  }
  if (generationEnabled && !['true', 'false'].includes(generationEnabled)) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  }
  if (generationEnabled === 'true' && infrastructureEnabled !== 'true') {
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  }
  if (infrastructureEnabled !== 'true') return PRODUCTION_CONNECTED_PROFILE;
  return Object.freeze({
    ...PRODUCTION_CONNECTED_PROFILE,
    generationEnabled: generationEnabled === 'true',
    queueName: PRODUCTION_GENERATION_QUEUE,
    crons: ['* * * * *', '0 15 * * *'],
    requiredSecretBindings: [
      'SUPABASE_SECRET_KEY',
      'TURNSTILE_SECRET_KEY',
      'OPENAI_API_KEY',
      'GENERATION_ALLOWED_OWNER_ID',
    ],
  });
}

export function productionGenerationQueueConfiguration(queue: string) {
  return {
    producers: [{ binding: 'GENERATION_QUEUE', queue }],
    consumers: [
      { queue, max_batch_size: 1, max_batch_timeout: 0, max_retries: 3, max_concurrency: 10 },
    ],
  };
}

export type ProductionReleasePublicValues = Readonly<{
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
}>;

export type ProductionWorkerSecrets = Readonly<{
  SUPABASE_SECRET_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  OPENAI_API_KEY?: string;
  GENERATION_ALLOWED_OWNER_ID?: string;
}>;

export const PRODUCTION_PUBLIC_ENV_FILE = '.env.production.local';

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const turnstileTestSecretKeys = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export class ProductionConnectedDeploymentFailure extends Error {
  readonly code:
    | 'INPUT_PUBLIC_CONFIGURATION_INVALID'
    | 'INPUT_PRIVATE_SECRET_INVALID'
    | 'ARTIFACT_CONFIG_UNSAFE'
    | 'WORKER_BINDINGS_PRESENT'
    | 'SUPABASE_PROBE_FAILED';
  readonly publicSetting?:
    | 'VITE_SUPABASE_URL'
    | 'VITE_SUPABASE_PUBLISHABLE_KEY'
    | 'VITE_TURNSTILE_SITE_KEY';

  constructor(
    code: ProductionConnectedDeploymentFailure['code'],
    publicSetting?: ProductionConnectedDeploymentFailure['publicSetting'],
  ) {
    super(code);
    this.name = 'ProductionConnectedDeploymentFailure';
    this.code = code;
    this.publicSetting = publicSetting;
  }
}

export function validateProductionReleasePublicValues(values: ProductionReleasePublicValues): {
  workerPublicVars: Readonly<Record<string, string>>;
} {
  try {
    assertNoKnownServerKeyFormats(values as Record<string, string>);
    assertProductionPublicConfiguration(values as Record<string, string>);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const publicSetting = (
      ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_TURNSTILE_SITE_KEY'] as const
    ).find((setting) => message.startsWith(setting));
    throw new ProductionConnectedDeploymentFailure(
      'INPUT_PUBLIC_CONFIGURATION_INVALID',
      publicSetting,
    );
  }

  return {
    workerPublicVars: {
      SUPABASE_URL: PRODUCTION_SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: values.VITE_SUPABASE_PUBLISHABLE_KEY!,
      TURNSTILE_ALLOWED_HOSTNAMES: PRODUCTION_WORKER_HOSTNAME,
    },
  };
}

export async function writeProductionPublicEnvironmentFile(
  projectRoot: string,
  values: ProductionReleasePublicValues,
): Promise<string> {
  validateProductionReleasePublicValues(values);
  const filePath = join(projectRoot, PRODUCTION_PUBLIC_ENV_FILE);
  try {
    await lstat(filePath);
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  } catch (error) {
    if (error instanceof ProductionConnectedDeploymentFailure) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
    }
  }

  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    created = true;
    const lines = [
      ['VITE_SUPABASE_URL', values.VITE_SUPABASE_URL],
      ['VITE_SUPABASE_PUBLISHABLE_KEY', values.VITE_SUPABASE_PUBLISHABLE_KEY],
      ['VITE_TURNSTILE_SITE_KEY', values.VITE_TURNSTILE_SITE_KEY],
    ].map(([name, value]) => `${name}=${JSON.stringify(value)}\n`);
    await handle.writeFile(lines.join(''), 'utf8');
    await handle.sync();
    return filePath;
  } catch {
    if (created) {
      await handle?.close().catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
    }
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export async function removeProductionPublicEnvironmentFile(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
    }
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof ProductionConnectedDeploymentFailure) throw error;
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
  }
}

function assertSingleLineSecret(value: string | undefined): string {
  if (!value || value.trim() !== value || containsControlCharacters(value)) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
  }
  return value;
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

export function validateProductionWorkerSecrets(
  values: Partial<ProductionWorkerSecrets>,
  profile = PRODUCTION_CONNECTED_PROFILE,
): ProductionWorkerSecrets {
  const supabaseSecretKey = assertSingleLineSecret(values.SUPABASE_SECRET_KEY);
  if (
    !(
      /^sb_secret_[A-Za-z0-9_-]+$/.test(supabaseSecretKey) ||
      isLegacyServiceRoleJwt(supabaseSecretKey)
    )
  ) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
  }

  const turnstileSecretKey = assertSingleLineSecret(values.TURNSTILE_SECRET_KEY);
  if (turnstileTestSecretKeys.has(turnstileSecretKey)) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
  }

  const openaiRequired = profile.requiredSecretBindings?.includes('OPENAI_API_KEY');
  let openaiKey: string | undefined;
  let allowedOwner: string | undefined;
  if (openaiRequired) {
    allowedOwner = assertSingleLineSecret(values.GENERATION_ALLOWED_OWNER_ID);
    if (
      allowedOwner !== 'all' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(allowedOwner)
    ) {
      throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
    }
    openaiKey = assertSingleLineSecret(values.OPENAI_API_KEY);
    if (!/^sk-[A-Za-z0-9_-]+$/.test(openaiKey)) {
      throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
    }
  } else if (
    values.OPENAI_API_KEY !== undefined ||
    values.GENERATION_ALLOWED_OWNER_ID !== undefined
  ) {
    throw new ProductionConnectedDeploymentFailure('INPUT_PRIVATE_SECRET_INVALID');
  }
  return {
    ...(openaiKey ? { OPENAI_API_KEY: openaiKey, GENERATION_ALLOWED_OWNER_ID: allowedOwner } : {}),
    SUPABASE_SECRET_KEY: supabaseSecretKey,
    TURNSTILE_SECRET_KEY: turnstileSecretKey,
  };
}
