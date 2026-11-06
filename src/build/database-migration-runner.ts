import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  DEV_DATABASE_HOST,
  DEV_DATABASE_NAME,
  DEV_DATABASE_PORT,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  DEV_DATABASE_USER,
} from './dev-database-preflight.ts';

export const SUPABASE_DB_PUSH_TIMEOUT_MS = 120_000;
export const SUPABASE_DB_PUSH_MAX_OUTPUT_BYTES = 1024 * 1024;
export const SUPABASE_DB_PUSH_ARGS = [
  'db',
  'push',
  '--skip-vault',
  '--yes',
  '--log-level',
  'fatal',
] as const;

export type SupabaseCliFailureCode =
  | 'CLI_START_FAILED'
  | 'CLI_TIMEOUT'
  | 'CLI_OUTPUT_TOO_LARGE'
  | 'CLI_COMMAND_FAILED';

export class SupabaseCliFailure extends Error {
  readonly code: SupabaseCliFailureCode;

  constructor(code: SupabaseCliFailureCode) {
    super(code);
    this.name = 'SupabaseCliFailure';
    this.code = code;
  }
}

type SpawnProcess = typeof spawn;

export type SupabaseCliExecution = Readonly<{
  cliPath: string;
  workdir: string;
  databasePassword: string;
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
  maxOutputBytes?: number;
}>;

export type SupabaseCliRunnerDependencies = Readonly<{
  spawnProcess?: SpawnProcess;
  testDatabaseUrl?: string;
}>;

export function buildPasswordFreeDatabaseUrl(): string {
  const query = new URLSearchParams({
    sslmode: 'verify-full',
    sslrootcert: DEV_DATABASE_ROOT_CERTIFICATE_PATH,
    application_name: 'manga-nikki-database-migration',
  });
  return `postgresql://${DEV_DATABASE_USER}@${DEV_DATABASE_HOST}:${DEV_DATABASE_PORT}/${DEV_DATABASE_NAME}?${query}`;
}

export function createSupabaseCliEnvironment(
  cliPath: string,
  databasePassword: string,
): NodeJS.ProcessEnv {
  const cliDirectory = cliPath.slice(0, cliPath.lastIndexOf('/'));
  return {
    PATH: `${cliDirectory}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    CI: 'true',
    SUPABASE_DISABLE_TELEMETRY: 'true',
    PGPASSWORD: databasePassword,
  };
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'linux' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  child.kill(signal);
}

export async function runSupabaseDbPush(
  options: SupabaseCliExecution,
  dependencies: SupabaseCliRunnerDependencies = {},
): Promise<void> {
  const runSpawn = dependencies.spawnProcess ?? options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? SUPABASE_DB_PUSH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? SUPABASE_DB_PUSH_MAX_OUTPUT_BYTES;
  const databaseUrl = dependencies.testDatabaseUrl ?? buildPasswordFreeDatabaseUrl();
  const args = [...SUPABASE_DB_PUSH_ARGS, '--db-url', databaseUrl, '--workdir', options.workdir];
  const environment = createSupabaseCliEnvironment(options.cliPath, options.databasePassword);

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = runSpawn(options.cliPath, args, {
        cwd: options.workdir,
        env: environment,
        detached: process.platform === 'linux',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new SupabaseCliFailure('CLI_START_FAILED'));
      return;
    }

    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const finish = (error?: SupabaseCliFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcessGroup(child, 'SIGTERM');
      } catch {
        // The child may exit between the timeout and the signal.
      }
      forceKill = setTimeout(() => {
        try {
          terminateProcessGroup(child, 'SIGKILL');
        } catch {
          // The child may exit before the forced kill.
        }
      }, 1_000);
    }, timeoutMs);

    const collect = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes && !overflowed) {
        overflowed = true;
        try {
          terminateProcessGroup(child, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => finish(new SupabaseCliFailure('CLI_START_FAILED')));
    child.once('close', (code) => {
      if (timedOut) finish(new SupabaseCliFailure('CLI_TIMEOUT'));
      else if (overflowed) finish(new SupabaseCliFailure('CLI_OUTPUT_TOO_LARGE'));
      else if (code !== 0) finish(new SupabaseCliFailure('CLI_COMMAND_FAILED'));
      else finish();
    });
  });
}
