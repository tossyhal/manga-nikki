import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
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
  | 'CLI_COMMAND_FAILED'
  | 'CLI_INTERRUPTED';

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
  signalSource?: Pick<EventEmitter, 'on' | 'off'>;
  forceKillDelayMs?: number;
  settleAfterKillDelayMs?: number;
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
    } catch {
      // Fall back to the direct child if its process group is already gone or inaccessible.
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
  const signalSource = dependencies.signalSource ?? process;
  const forceKillDelayMs = dependencies.forceKillDelayMs ?? 1_000;
  const settleAfterKillDelayMs = dependencies.settleAfterKillDelayMs ?? 5_000;
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
    let interrupted = false;
    let terminationRequested = false;
    let hardKillSent = false;
    let forceKill: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;

    const finish = (error?: SupabaseCliFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (abandonTimer) clearTimeout(abandonTimer);
      signalSource.off('SIGTERM', onSigterm);
      signalSource.off('SIGINT', onSigint);
      if (error) reject(error);
      else resolve();
    };

    const sendHardKill = (): void => {
      if (hardKillSent || settled) return;
      hardKillSent = true;
      try {
        terminateProcessGroup(child, 'SIGKILL');
      } catch {
        // The child may already have exited.
      }
      abandonTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        const failureCode = interrupted
          ? 'CLI_INTERRUPTED'
          : timedOut
            ? 'CLI_TIMEOUT'
            : overflowed
              ? 'CLI_OUTPUT_TOO_LARGE'
              : 'CLI_COMMAND_FAILED';
        finish(new SupabaseCliFailure(failureCode));
      }, settleAfterKillDelayMs);
    };

    const stopProcessGroup = (signal: NodeJS.Signals): void => {
      if (!terminationRequested) {
        terminationRequested = true;
        try {
          terminateProcessGroup(child, signal);
        } catch {
          // The child may exit before it receives the signal.
        }
      }
      if (!forceKill && !hardKillSent) forceKill = setTimeout(sendHardKill, forceKillDelayMs);
    };

    const onSigterm = (): void => {
      if (settled || interrupted) return;
      interrupted = true;
      stopProcessGroup('SIGTERM');
    };
    const onSigint = (): void => {
      if (settled || interrupted) return;
      interrupted = true;
      stopProcessGroup('SIGINT');
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup('SIGTERM');
    }, timeoutMs);

    signalSource.on('SIGTERM', onSigterm);
    signalSource.on('SIGINT', onSigint);

    const collect = (chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes && !overflowed) {
        overflowed = true;
        terminationRequested = true;
        sendHardKill();
      }
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => {
      if (terminationRequested && !hardKillSent) sendHardKill();
      const failureCode = interrupted
        ? 'CLI_INTERRUPTED'
        : timedOut
          ? 'CLI_TIMEOUT'
          : overflowed
            ? 'CLI_OUTPUT_TOO_LARGE'
            : 'CLI_START_FAILED';
      finish(new SupabaseCliFailure(failureCode));
    });
    child.once('close', (code) => {
      if (terminationRequested && !hardKillSent) sendHardKill();
      if (interrupted) finish(new SupabaseCliFailure('CLI_INTERRUPTED'));
      else if (timedOut) finish(new SupabaseCliFailure('CLI_TIMEOUT'));
      else if (overflowed) finish(new SupabaseCliFailure('CLI_OUTPUT_TOO_LARGE'));
      else if (code !== 0) finish(new SupabaseCliFailure('CLI_COMMAND_FAILED'));
      else finish();
    });
  });
}
