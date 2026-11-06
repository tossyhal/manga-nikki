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

export type ProductionReleasePublicValues = Readonly<{
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
}>;

export type ProductionWorkerSecrets = Readonly<{
  SUPABASE_SECRET_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}>;

export const PRODUCTION_PUBLIC_ENV_FILE = '.env.production.local';

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

  constructor(code: ProductionConnectedDeploymentFailure['code']) {
    super(code);
    this.name = 'ProductionConnectedDeploymentFailure';
    this.code = code;
  }
}

export function validateProductionReleasePublicValues(values: ProductionReleasePublicValues): {
  workerPublicVars: Readonly<Record<string, string>>;
} {
  try {
    assertNoKnownServerKeyFormats(values as Record<string, string>);
    assertProductionPublicConfiguration(values as Record<string, string>);
  } catch {
    throw new ProductionConnectedDeploymentFailure('INPUT_PUBLIC_CONFIGURATION_INVALID');
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
  if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
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

  return {
    SUPABASE_SECRET_KEY: supabaseSecretKey,
    TURNSTILE_SECRET_KEY: turnstileSecretKey,
  };
}
