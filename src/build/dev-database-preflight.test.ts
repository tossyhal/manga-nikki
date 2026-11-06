import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingMigrationPlan,
  DEV_DATABASE_APP_NAME,
  DEV_DATABASE_HOST,
  DEV_DATABASE_NAME,
  DEV_DATABASE_PORT,
  DEV_DATABASE_PROJECT_REF,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  DEV_DATABASE_SETUP_ACTOR_ID,
  DEV_DATABASE_SETUP_REF,
  DEV_DATABASE_SETUP_REPOSITORY,
  DEV_DATABASE_SETUP_TRIGGERING_ACTOR,
  DEV_DATABASE_USER,
  DevDatabasePreflightFailure,
  readLocalMigrations,
  renderDevDatabasePreflightSummary,
  runDevDatabasePreflight,
  runDevDatabasePreflightGate,
  verifyPinnedRootCertificate,
  type DevDatabasePreflightContext,
  type DevDatabasePreflightErrorCode,
  type LocalMigration,
} from './dev-database-preflight.ts';

const commit = 'a'.repeat(40);
const password = 'test-only-db-password';
const secretId = '00000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

function context(
  overrides: Partial<DevDatabasePreflightContext> = {},
): DevDatabasePreflightContext {
  return {
    githubActions: 'true',
    githubRepository: DEV_DATABASE_SETUP_REPOSITORY,
    githubRef: DEV_DATABASE_SETUP_REF,
    githubEventName: 'workflow_dispatch',
    githubSha: commit,
    githubActorId: DEV_DATABASE_SETUP_ACTOR_ID,
    githubTriggeringActor: DEV_DATABASE_SETUP_TRIGGERING_ACTOR,
    githubToken: 'github-token-for-head-only',
    bwsSecretId: secretId,
    databasePassword: password,
    ...overrides,
  };
}

function githubHead(sha = commit): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ commit: { sha } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof fetch;
}

function migration(version: string, filename = `${version}_first.sql`): LocalMigration {
  return { version, filename, sha256: 'b'.repeat(64) };
}

const baselineTables = {
  publicTablesPresent: true,
  entriesPresent: true,
  generationsPresent: true,
} as const;
const noPublicTables = {
  publicTablesPresent: false,
  entriesPresent: false,
  generationsPresent: false,
} as const;

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'manga-nikki-migrations-'));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([filename, contents]) =>
      writeFile(join(directory, filename), contents),
    ),
  );
  return directory;
}

async function failureCode(promise: Promise<unknown>): Promise<DevDatabasePreflightErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DevDatabasePreflightFailure);
    return (error as DevDatabasePreflightFailure).code;
  }
  throw new Error('Expected dev database preflight failure');
}

function syncFailureCode(action: () => unknown): DevDatabasePreflightErrorCode {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DevDatabasePreflightFailure);
    return (error as DevDatabasePreflightFailure).code;
  }
  throw new Error('Expected dev database preflight failure');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('開発DB preflight gate', () => {
  it.each([
    ['repository', { githubRepository: 'attacker/repository' }],
    ['ref', { githubRef: 'refs/heads/develop' }],
    ['event', { githubEventName: 'push' }],
  ] as const)('%sが許可外ならDB照会前に停止する', async (_name, override) => {
    const runPsql = vi.fn(async () => '');
    const fetcher = githubHead();
    const code = await failureCode(
      runDevDatabasePreflight(context(override), { fetcher, runPsql }),
    );

    expect(code).toBe('INPUT_CONTEXT_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('owner以外はDB照会前に停止する', async () => {
    const runPsql = vi.fn(async () => '');
    const fetcher = githubHead();
    const code = await failureCode(
      runDevDatabasePreflight(context({ githubActorId: '0' }), { fetcher, runPsql }),
    );

    expect(code).toBe('INPUT_ACTOR_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('workflow起動者がowner以外の場合もDB照会前に停止する', async () => {
    const runPsql = vi.fn(async () => '');
    const fetcher = githubHead();
    const code = await failureCode(
      runDevDatabasePreflight(context({ githubTriggeringActor: 'other-user' }), {
        fetcher,
        runPsql,
      }),
    );

    expect(code).toBe('INPUT_ACTOR_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('Bitwarden secret IDがUUIDでない場合は取得前に停止する', async () => {
    const runPsql = vi.fn(async () => '');
    const fetcher = githubHead();
    const code = await failureCode(
      runDevDatabasePreflight(context({ bwsSecretId: 'invalid-secret-id' }), {
        fetcher,
        runPsql,
      }),
    );

    expect(code).toBe('INPUT_SECRET_ID_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('実行時のmain HEADと異なるcommitならDB照会前に停止する', async () => {
    const runPsql = vi.fn(async () => '');
    const fetcher = githubHead('c'.repeat(40));
    const code = await failureCode(runDevDatabasePreflight(context(), { fetcher, runPsql }));

    expect(code).toBe('GITHUB_HEAD_STALE');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('head確認専用gateもowner/ref/最新mainを確認する', async () => {
    const fetcher = githubHead();
    await expect(runDevDatabasePreflightGate(context(), { fetcher })).resolves.toBe(commit);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching('/branches/main$'),
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});

describe('固定ルート証明書', () => {
  it('commit済みCAのhash、fingerprint、有効期間を検証する', async () => {
    await expect(
      verifyPinnedRootCertificate(
        DEV_DATABASE_ROOT_CERTIFICATE_PATH,
        new Date('2026-11-06T00:00:00Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('期限切れCAを拒否する', async () => {
    expect(
      await failureCode(
        verifyPinnedRootCertificate(
          DEV_DATABASE_ROOT_CERTIFICATE_PATH,
          new Date('2032-01-01T00:00:00Z'),
        ),
      ),
    ).toBe('ROOT_CERTIFICATE_NOT_CURRENT');
  });

  it('差し替えられたCAをhash不一致として拒否する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manga-nikki-certificate-'));
    temporaryDirectories.push(directory);
    const certificatePath = join(directory, 'root.crt');
    await writeFile(certificatePath, 'untrusted root certificate');

    expect(await failureCode(verifyPinnedRootCertificate(certificatePath))).toBe(
      'ROOT_CERTIFICATE_HASH_INVALID',
    );
  });
});

describe('ローカルmigration manifest', () => {
  it('通常ファイルだけをversion順に列挙しSHA-256を計算する', async () => {
    const directory = await migrationDirectory({
      '20260102000000_second.sql': 'select 2;\n',
      '20260101000000_first.sql': 'select 1;\n',
    });

    await expect(readLocalMigrations(directory)).resolves.toEqual([
      {
        version: '20260101000000',
        filename: '20260101000000_first.sql',
        sha256: createHash('sha256').update('select 1;\n').digest('hex'),
      },
      {
        version: '20260102000000',
        filename: '20260102000000_second.sql',
        sha256: createHash('sha256').update('select 2;\n').digest('hex'),
      },
    ]);
  });

  it('migration symlinkを拒否する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manga-nikki-migration-link-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'target'));
    await writeFile(join(directory, 'target', 'migration.sql'), 'select 1;');
    await symlink(
      join(directory, 'target', 'migration.sql'),
      join(directory, '20260101000000_first.sql'),
    );

    expect(await failureCode(readLocalMigrations(directory))).toBe('LOCAL_MIGRATION_FILE_INVALID');
  });

  it('重複versionを拒否する', async () => {
    const directory = await migrationDirectory({
      '20260101000000_first.sql': 'select 1;',
      '20260101000000_second.sql': 'select 2;',
    });

    expect(await failureCode(readLocalMigrations(directory))).toBe(
      'LOCAL_MIGRATION_VERSION_DUPLICATE',
    );
  });

  it('14桁versionでないSQL filenameを拒否する', async () => {
    const directory = await migrationDirectory({ 'migration.sql': 'select 1;' });
    expect(await failureCode(readLocalMigrations(directory))).toBe('LOCAL_MIGRATION_FILE_INVALID');
  });
});

describe('remote migration照合', () => {
  const local = [
    migration('20260101000000'),
    migration('20260102000000'),
    migration('20260103000000'),
  ];

  it('remote historyがlocal migrationの順序付きprefixなら残りをpendingにする', () => {
    expect(
      buildPendingMigrationPlan(local, ['20260101000000', '20260102000000'], true, baselineTables),
    ).toEqual([local[2]]);
  });

  it('未知version、順序のgap、remote追加versionを拒否する', () => {
    expect(() =>
      buildPendingMigrationPlan(local, ['20260101000000', '20260109000000'], true, baselineTables),
    ).toThrowError(DevDatabasePreflightFailure);
    expect(() =>
      buildPendingMigrationPlan(local, ['20260102000000'], true, baselineTables),
    ).toThrowError(DevDatabasePreflightFailure);
    expect(() =>
      buildPendingMigrationPlan(
        local,
        ['20260101000000', '20260102000000', '20260103000000', '20260104000000'],
        true,
        baselineTables,
      ),
    ).toThrowError(DevDatabasePreflightFailure);
  });

  it('migration historyがない状態でpublic tableがあれば拒否する', () => {
    expect(syncFailureCode(() => buildPendingMigrationPlan(local, [], false, baselineTables))).toBe(
      'APP_TABLES_WITHOUT_MIGRATION_HISTORY',
    );
  });

  it('空のmigration historyと既存public tableは不整合として拒否する', () => {
    expect(syncFailureCode(() => buildPendingMigrationPlan(local, [], true, baselineTables))).toBe(
      'APP_TABLES_WITHOUT_MIGRATION_HISTORY',
    );
  });

  it('unknown public tableはmigration未追跡として拒否する', () => {
    const unknownPublicTable = {
      publicTablesPresent: true,
      entriesPresent: false,
      generationsPresent: false,
    } as const;
    expect(
      syncFailureCode(() => buildPendingMigrationPlan(local, [], false, unknownPublicTable)),
    ).toBe('APP_TABLES_WITHOUT_MIGRATION_HISTORY');
  });

  it('remote migration historyがある場合entriesとgenerationsの両方を要求する', () => {
    expect(
      syncFailureCode(() =>
        buildPendingMigrationPlan(local, ['20260101000000'], true, {
          publicTablesPresent: true,
          entriesPresent: true,
          generationsPresent: false,
        }),
      ),
    ).toBe('MIGRATION_HISTORY_WITHOUT_APPLICATION_TABLES');
  });

  it('history table未作成かつpublic tableがなければ全migrationをpendingにする', () => {
    expect(buildPendingMigrationPlan(local, [], false, noPublicTables)).toEqual(local);
  });
});

describe('読み取り専用DB preflight', () => {
  it('固定接続先だけを確認しhistory versionだけを取得してsummaryを作る', async () => {
    const directory = await migrationDirectory({
      '20260101000000_first.sql': 'select 1;',
      '20260102000000_second.sql': 'select 2;',
    });
    const runPsql = vi
      .fn<(sql: string, secret: string) => Promise<string>>()
      .mockResolvedValueOnce(
        `${JSON.stringify({
          connectionOk: true,
          historyExists: true,
          publicTablesPresent: true,
          entriesPresent: true,
          generationsPresent: true,
        })}\n`,
      )
      .mockResolvedValueOnce('20260101000000\n');

    const result = await runDevDatabasePreflight(context(), {
      fetcher: githubHead(),
      migrationsDirectory: directory,
      runPsql,
    });
    const summary = renderDevDatabasePreflightSummary(result);

    expect(runPsql).toHaveBeenCalledTimes(2);
    expect(runPsql.mock.calls[0]?.[0]).toContain('BEGIN READ ONLY;');
    expect(runPsql.mock.calls[0]?.[0]).toContain('ROLLBACK;');
    expect(runPsql.mock.calls[0]?.[0]).toContain(
      "pg_catalog.current_setting('transaction_read_only') = 'on'",
    );
    expect(runPsql.mock.calls[0]?.[0]).toContain(
      "pg_catalog.current_setting('default_transaction_read_only') = 'on'",
    );
    expect(runPsql.mock.calls[0]?.[0]).toContain(
      "pg_catalog.current_setting('statement_timeout') = '15s'",
    );
    expect(runPsql.mock.calls[0]?.[0]).toContain(
      "pg_catalog.current_setting('lock_timeout') = '5s'",
    );
    expect(runPsql.mock.calls[0]?.[0]).toContain(
      "pg_catalog.current_setting('search_path') = 'pg_catalog'",
    );
    expect(runPsql.mock.calls[0]?.[0]).toContain('FROM pg_catalog.pg_class AS relation');
    expect(runPsql.mock.calls[0]?.[0]).toContain('JOIN pg_catalog.pg_namespace AS namespace');
    expect(runPsql.mock.calls[0]?.[1]).toBe(password);
    expect(runPsql.mock.calls[1]?.[0]).toContain(
      'SELECT version FROM supabase_migrations.schema_migrations',
    );
    expect(runPsql.mock.calls[1]?.[0]).not.toContain('statements');
    expect(runPsql.mock.calls[1]?.[0]).toContain('BEGIN READ ONLY;');
    expect(result.remoteVersions).toEqual(['20260101000000']);
    expect(result.pendingMigrations.map(({ filename }) => filename)).toEqual([
      '20260102000000_second.sql',
    ]);
    expect(summary).toContain(DEV_DATABASE_PROJECT_REF);
    expect(summary).toContain(DEV_DATABASE_HOST);
    expect(summary).toContain(commit);
    expect(summary).toContain('20260102000000_second.sql');
    expect(summary).not.toContain(password);
    expect(summary).toContain('Auth・Storage設定未変更');
    expect(summary).toContain('Worker未変更');
    expect(summary).toContain('RLS動作検証完了や公開可能を意味しません');
    expect(DEV_DATABASE_HOST).toBe('aws-0-ap-northeast-1.pooler.supabase.com');
    expect(DEV_DATABASE_PORT).toBe('5432');
    expect(DEV_DATABASE_NAME).toBe('postgres');
    expect(DEV_DATABASE_USER).toBe('postgres.leihsygtsamxffyybskh');
    expect(DEV_DATABASE_APP_NAME).toBe('manga-nikki-dev-db-preflight');
  });

  it('historyが未作成ならversion queryをせず成功する', async () => {
    const runPsql = vi.fn(
      async () =>
        `${JSON.stringify({
          connectionOk: true,
          historyExists: false,
          publicTablesPresent: false,
          entriesPresent: false,
          generationsPresent: false,
        })}\n`,
    );

    const result = await runDevDatabasePreflight(context(), {
      fetcher: githubHead(),
      runPsql,
    });

    expect(runPsql).toHaveBeenCalledTimes(1);
    expect(result.migrationHistory).toBe('absent');
    expect(result.remoteVersions).toEqual([]);
  });

  it('subprocessの生エラーに秘密値があっても固定codeだけを返す', async () => {
    const runPsql = vi.fn(async () => {
      throw new Error(`password=${password}; raw database response`);
    });

    try {
      await runDevDatabasePreflight(context(), { fetcher: githubHead(), runPsql });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DevDatabasePreflightFailure);
      expect((error as Error).message).toBe('DATABASE_QUERY_FAILED');
      expect((error as Error).message).not.toContain(password);
      expect((error as Error).message).not.toContain('raw database response');
    }
  });
});
