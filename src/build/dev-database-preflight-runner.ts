import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export const DEV_DATABASE_PSQL_PATH = '/usr/lib/postgresql/16/bin/psql';
export const DEV_DATABASE_PSQL_TIMEOUT_MS = 30_000;
export const DEV_DATABASE_PSQL_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEV_DATABASE_PSQL_ARGS = [
  '-X',
  '--no-password',
  '-qAt',
  '-v',
  'ON_ERROR_STOP=1',
  '-f',
  '-',
] as const;

export type PsqlFailureCode =
  | 'PSQL_START_FAILED'
  | 'PSQL_TIMEOUT'
  | 'PSQL_OUTPUT_TOO_LARGE'
  | 'PSQL_COMMAND_FAILED';

export class PsqlProcessFailure extends Error {
  readonly code: PsqlFailureCode;

  constructor(code: PsqlFailureCode) {
    super(code);
    this.name = 'PsqlProcessFailure';
    this.code = code;
  }
}

export type PsqlConnection = Readonly<{
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslRootCert: string;
  appName: string;
}>;

type SpawnProcess = typeof spawn;

type RunPsqlOptions = Readonly<{
  connection: PsqlConnection;
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
  maxOutputBytes?: number;
}>;

export function createPsqlEnvironment(connection: PsqlConnection): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
  environment.PGHOST = connection.host;
  environment.PGPORT = connection.port;
  environment.PGDATABASE = connection.database;
  environment.PGUSER = connection.user;
  environment.PGPASSWORD = connection.password;
  environment.PGSSLMODE = 'verify-full';
  environment.PGSSLROOTCERT = connection.sslRootCert;
  environment.PGCONNECT_TIMEOUT = '10';
  environment.PGOPTIONS =
    '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000 -c search_path=pg_catalog';
  environment.PGAPPNAME = connection.appName;

  return environment;
}

export async function runPsqlReadOnlyQuery(sql: string, options: RunPsqlOptions): Promise<string> {
  const runSpawn = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEV_DATABASE_PSQL_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEV_DATABASE_PSQL_MAX_OUTPUT_BYTES;
  const environment = createPsqlEnvironment(options.connection);

  return await new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = runSpawn(DEV_DATABASE_PSQL_PATH, [...DEV_DATABASE_PSQL_ARGS], {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new PsqlProcessFailure('PSQL_START_FAILED'));
      return;
    }

    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;

    const finish = (error?: PsqlProcessFailure, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output ?? '');
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.once('error', () => finish(new PsqlProcessFailure('PSQL_START_FAILED')));
    child.stdin.once('error', () => {
      child.kill('SIGKILL');
      finish(new PsqlProcessFailure('PSQL_COMMAND_FAILED'));
    });
    child.once('close', (code) => {
      if (timedOut) finish(new PsqlProcessFailure('PSQL_TIMEOUT'));
      else if (overflowed) finish(new PsqlProcessFailure('PSQL_OUTPUT_TOO_LARGE'));
      else if (code !== 0) finish(new PsqlProcessFailure('PSQL_COMMAND_FAILED'));
      else finish(undefined, Buffer.concat(stdout).toString('utf8'));
    });

    try {
      child.stdin.end(sql, 'utf8');
    } catch {
      child.kill('SIGKILL');
      finish(new PsqlProcessFailure('PSQL_COMMAND_FAILED'));
    }
  });
}
