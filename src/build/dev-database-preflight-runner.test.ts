import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createPsqlEnvironment,
  DEV_DATABASE_PSQL_ARGS,
  DEV_DATABASE_PSQL_MAX_OUTPUT_BYTES,
  DEV_DATABASE_PSQL_PATH,
  DEV_DATABASE_PSQL_TIMEOUT_MS,
  PsqlProcessFailure,
  runPsqlReadOnlyQuery,
  type PsqlConnection,
} from './dev-database-preflight-runner.ts';

const password = 'test-password-should-never-appear-in-argv-or-errors';

const connection: PsqlConnection = {
  host: 'aws-0-ap-northeast-1.pooler.supabase.com',
  port: '5432',
  database: 'postgres',
  user: 'postgres.leihsygtsamxffyybskh',
  password,
  sslRootCert: '/repo/supabase/certs/prod-ca-2021.crt',
  appName: 'manga-nikki-dev-db-preflight',
};

class FakeChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  });
  input = '';

  constructor(onInputEnd?: () => void) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.input += chunk.toString('utf8');
        callback();
      },
      final: (callback) => {
        callback();
        onInputEnd?.();
      },
    });
  }

  close(code: number | null, stdout = '', stderr = ''): void {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    this.emit('close', code, null);
  }
}

function spawnMock(
  child: FakeChild,
  onSpawn?: (file: string, args: string[], options: unknown) => void,
) {
  return vi.fn((file: string, args: string[], options: unknown) => {
    onSpawn?.(file, args, options);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

async function failureCode(promise: Promise<unknown>): Promise<PsqlProcessFailure['code']> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PsqlProcessFailure);
    return (error as PsqlProcessFailure).code;
  }
  throw new Error('Expected psql runner failure');
}

describe('psql read-only runner', () => {
  it('passwordをargvへ入れず、固定引数とallowlist環境だけでshellなしに起動する', async () => {
    const child = new FakeChild(() => queueMicrotask(() => child.close(0, 'true\n')));
    let recorded:
      | { file: string; args: string[]; options: { shell: boolean; env: NodeJS.ProcessEnv } }
      | undefined;
    const spawnProcess = spawnMock(child, (file, args, options) => {
      recorded = {
        file,
        args,
        options: options as { shell: boolean; env: NodeJS.ProcessEnv },
      };
    });

    await expect(
      runPsqlReadOnlyQuery('BEGIN READ ONLY; SELECT 1; ROLLBACK;', {
        connection,
        spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      }),
    ).resolves.toBe('true\n');

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(recorded?.file).toBe(DEV_DATABASE_PSQL_PATH);
    expect(recorded?.args).toEqual(DEV_DATABASE_PSQL_ARGS);
    expect(recorded?.args).not.toContain(password);
    expect(recorded?.options.shell).toBe(false);
    expect(recorded?.options.env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      PGHOST: connection.host,
      PGPORT: connection.port,
      PGDATABASE: connection.database,
      PGUSER: connection.user,
      PGPASSWORD: password,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: connection.sslRootCert,
      PGCONNECT_TIMEOUT: '10',
      PGOPTIONS:
        '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000 -c search_path=pg_catalog',
      PGAPPNAME: connection.appName,
    });
    expect(
      Object.keys(recorded?.options.env ?? {}).some((key) =>
        /^(GITHUB_|BWS_|PGPASSFILE|PGSERVICE|SUPABASE_)/.test(key),
      ),
    ).toBe(false);
    expect(child.input).toBe('BEGIN READ ONLY; SELECT 1; ROLLBACK;');
  });

  it('PG環境変数を呼び出し元から継承せず固定値で上書きする', () => {
    vi.stubEnv('PGHOST', 'attacker.example');
    vi.stubEnv('PGPORT', '6432');
    vi.stubEnv('PGDATABASE', 'attacker');
    vi.stubEnv('PGUSER', 'attacker');
    vi.stubEnv('PGPASSWORD', 'attacker-password');
    vi.stubEnv('PGSSLMODE', 'disable');
    vi.stubEnv('PGSSLROOTCERT', '/tmp/attacker.crt');
    vi.stubEnv('PGOPTIONS', 'default_transaction_read_only=off');
    vi.stubEnv('PGAPPNAME', 'attacker');
    vi.stubEnv('PGPASSFILE', '/tmp/attacker-pass');
    vi.stubEnv('PGSERVICE', 'attacker');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('BWS_ACCESS_TOKEN', 'bitwarden-token');

    const environment = createPsqlEnvironment(connection);

    expect(environment.PGHOST).toBe(connection.host);
    expect(environment.PGPORT).toBe(connection.port);
    expect(environment.PGDATABASE).toBe(connection.database);
    expect(environment.PGUSER).toBe(connection.user);
    expect(environment.PGPASSWORD).toBe(password);
    expect(environment.PGSSLMODE).toBe('verify-full');
    expect(environment.PGSSLROOTCERT).toBe(connection.sslRootCert);
    expect(environment.PGOPTIONS).toContain('default_transaction_read_only=on');
    expect(environment.PGAPPNAME).toBe(connection.appName);
    expect(environment.PGPASSFILE).toBeUndefined();
    expect(environment.PGSERVICE).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.BWS_ACCESS_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('失敗したpsqlのstdout/stderrとpasswordを例外へ含めない', async () => {
    const child = new FakeChild(() =>
      queueMicrotask(() => child.close(1, `raw=${password}`, `server echoed ${password}`)),
    );
    const spawnProcess = spawnMock(child);

    const code = await failureCode(
      runPsqlReadOnlyQuery('SELECT 1;', {
        connection,
        spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      }),
    );

    expect(code).toBe('PSQL_COMMAND_FAILED');
    expect(child.input).toBe('SELECT 1;');
    expect(await Promise.resolve(code)).not.toContain(password);
  });

  it('stdin EPIPEを固定codeへ変換しprocessを終了する', async () => {
    const child = new FakeChild(() =>
      queueMicrotask(() => child.stdin.emit('error', new Error(`EPIPE ${password}`))),
    );
    const spawnProcess = spawnMock(child);

    const code = await failureCode(
      runPsqlReadOnlyQuery('SELECT 1;', {
        connection,
        spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      }),
    );

    expect(code).toBe('PSQL_COMMAND_FAILED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('30秒timeoutと最大1MiB出力上限を固定する', async () => {
    expect(DEV_DATABASE_PSQL_TIMEOUT_MS).toBe(30_000);
    expect(DEV_DATABASE_PSQL_MAX_OUTPUT_BYTES).toBe(1024 * 1024);

    const child = new FakeChild(() => queueMicrotask(() => child.close(0, 'too much output')));
    const spawnProcess = spawnMock(child);
    const code = await failureCode(
      runPsqlReadOnlyQuery('SELECT 1;', {
        connection,
        spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
        maxOutputBytes: 3,
      }),
    );
    expect(code).toBe('PSQL_OUTPUT_TOO_LARGE');
  });
});
