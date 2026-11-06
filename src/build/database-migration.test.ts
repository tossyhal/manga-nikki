import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseMigrationManifest,
  hashDatabaseMigrationManifest,
  renderDatabaseMigrationSummary,
  runDatabaseMigration,
  runDatabaseMigrationGate,
  validateDatabaseMigrationInput,
  validatePinnedSupabaseCli,
  type DatabaseMigrationDependencies,
  type DatabaseMigrationInput,
  type PinnedCliConfiguration,
} from './database-migration.ts';
import {
  DEV_DATABASE_PROJECT_REF,
  DEV_DATABASE_SETUP_ACTOR_ID,
  DEV_DATABASE_SETUP_REF,
  DEV_DATABASE_SETUP_REPOSITORY,
  DEV_DATABASE_SETUP_TRIGGERING_ACTOR,
  DevDatabasePreflightFailure,
  type DevDatabasePreflightContext,
  type DevDatabasePreflightResult,
  type LocalMigration,
} from './dev-database-preflight.ts';

const commit = 'a'.repeat(40);
const databasePassword = 'database-password-test-only';
const secretId = '00000000-0000-4000-8000-000000000001';
const firstSource = 'CREATE TABLE public.first_table(id integer PRIMARY KEY);\n';
const secondSource = 'ALTER TABLE public.first_table ADD COLUMN value text;\n';
const firstVersion = '20260101000000';
const secondVersion = '20260102000000';
const firstMigration: LocalMigration = {
  version: firstVersion,
  filename: `${firstVersion}_first.sql`,
  sha256: createHash('sha256').update(firstSource).digest('hex'),
};
const secondMigration: LocalMigration = {
  version: secondVersion,
  filename: `${secondVersion}_second.sql`,
  sha256: createHash('sha256').update(secondSource).digest('hex'),
};
const allMigrations = [firstMigration, secondMigration];
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
    githubToken: 'github-token-test-only',
    bwsSecretId: secretId,
    databasePassword,
    ...overrides,
  };
}

function preflight(
  overrides: Partial<DevDatabasePreflightResult> = {},
): DevDatabasePreflightResult {
  return {
    commit,
    remoteVersions: [firstVersion],
    migrationHistory: 'present',
    pendingMigrations: [secondMigration],
    ...overrides,
  };
}

function input(overrides: Partial<DatabaseMigrationInput> = {}): DatabaseMigrationInput {
  return { operation: 'plan', expectedManifest: undefined, runAttempt: '1', ...overrides };
}

function migrationDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-source-')).then(async (directory) => {
    temporaryDirectories.push(directory);
    await writeFile(join(directory, firstMigration.filename), firstSource);
    await writeFile(join(directory, secondMigration.filename), secondSource);
    return directory;
  });
}

async function pinnedCli(root: string): Promise<PinnedCliConfiguration> {
  const cliDirectory = join(root, 'manga-nikki-supabase-cli-v2.122.0');
  await mkdir(cliDirectory, { mode: 0o700 });
  const cliPath = join(cliDirectory, 'supabase');
  const sidecarPath = join(cliDirectory, 'supabase-go');
  const cliContents = Buffer.from('pinned-supabase-cli-test-binary');
  const sidecarContents = Buffer.from('pinned-supabase-sidecar-test-binary');
  await writeFile(cliPath, cliContents, { mode: 0o700 });
  await writeFile(sidecarPath, sidecarContents, { mode: 0o700 });
  return {
    runnerTemporaryDirectory: root,
    cliPath,
    cliSha256: createHash('sha256').update(cliContents).digest('hex'),
    sidecarPath,
    sidecarSha256: createHash('sha256').update(sidecarContents).digest('hex'),
  };
}

function baseDependencies(
  migrationPath: string,
  overrides: Partial<DatabaseMigrationDependencies> = {},
): DatabaseMigrationDependencies {
  return {
    migrationsDirectory: migrationPath,
    runPreflight: vi.fn(async () => preflight()),
    runGate: vi.fn(async () => commit),
    verifyCertificate: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function expectFailureCode(
  promise: Promise<unknown>,
  expected: string,
  databaseWriteAttempted?: boolean,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: expected,
    ...(databaseWriteAttempted === undefined ? {} : { databaseWriteAttempted }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('database migration inputs and manifest', () => {
  it('requires an apply manifest and validates its lowercase SHA-256 form', () => {
    expect(() => validateDatabaseMigrationInput(input({ operation: 'apply' }))).toThrow(
      expect.objectContaining({ code: 'INPUT_MANIFEST_REQUIRED' }),
    );
    expect(() =>
      validateDatabaseMigrationInput(input({ operation: 'apply', expectedManifest: 'abc' })),
    ).toThrow(expect.objectContaining({ code: 'INPUT_MANIFEST_INVALID' }));
    expect(
      validateDatabaseMigrationInput(
        input({ operation: 'apply', expectedManifest: 'A'.repeat(64) }),
      ).expectedManifest,
    ).toBe('a'.repeat(64));
  });

  it('rejects apply reruns before the gate but allows plan reruns', async () => {
    const manifest = 'a'.repeat(64);
    for (const runAttempt of ['2', undefined]) {
      expect(() =>
        validateDatabaseMigrationInput(
          input({ operation: 'apply', expectedManifest: manifest, runAttempt }),
        ),
      ).toThrow(expect.objectContaining({ code: 'INPUT_APPLY_RERUN_FORBIDDEN' }));
    }
    expect(
      validateDatabaseMigrationInput(input({ operation: 'plan', runAttempt: '2' })).operation,
    ).toBe('plan');

    const gate = vi.fn(async () => commit);
    await expectFailureCode(
      runDatabaseMigrationGate(
        input({ operation: 'apply', expectedManifest: manifest, runAttempt: '2' }),
        context(),
        gate,
      ),
      'INPUT_APPLY_RERUN_FORBIDDEN',
    );
    expect(gate).not.toHaveBeenCalled();
  });

  it('hashes a stable manifest with project, commit, remote versions, and every local migration', () => {
    const manifest = createDatabaseMigrationManifest(
      { commit, remoteVersions: [firstVersion] },
      allMigrations,
    );
    expect(manifest).toEqual({
      projectRef: DEV_DATABASE_PROJECT_REF,
      sourceCommit: commit,
      remoteVersions: [firstVersion],
      localMigrations: allMigrations,
    });
    expect(hashDatabaseMigrationManifest(manifest)).toBe(
      hashDatabaseMigrationManifest(
        createDatabaseMigrationManifest({ commit, remoteVersions: [firstVersion] }, allMigrations),
      ),
    );
    expect(hashDatabaseMigrationManifest(manifest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('plan returns safe metadata without staging migrations or invoking the CLI', async () => {
    const source = await migrationDirectory();
    const cli = vi.fn();
    const result = await runDatabaseMigration(input(), context(), {
      ...baseDependencies(source),
      runCli: cli,
    });

    expect(result.operation).toBe('plan');
    expect(result.outcome).toBe('planned');
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pendingMigrations).toEqual([secondMigration]);
    expect(result.databaseWriteAttempted).toBe(false);
    expect(renderDatabaseMigrationSummary(result)).toContain('Database write attempted: no');
    expect(result.localMigrations).toEqual(allMigrations);
    expect(JSON.stringify(result)).not.toContain(databasePassword);
    expect(cli).not.toHaveBeenCalled();
  });

  it('rejects a mismatched manifest before creating a write workdir or invoking the CLI', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const cli = vi.fn();
    await expectFailureCode(
      runDatabaseMigration(
        input({ operation: 'apply', expectedManifest: '0'.repeat(64) }),
        context(),
        {
          ...baseDependencies(source),
          temporaryDirectory: root,
          cli: await pinnedCli(root),
          runCli: cli,
        },
      ),
      'EXPECTED_MANIFEST_MISMATCH',
      false,
    );
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
    expect(cli).not.toHaveBeenCalled();
  });

  it('rechecks the latest main gate and migration hashes after staging and cleans up on failure', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const runGate = vi.fn(async () => {
      await writeFile(join(source, secondMigration.filename), 'ALTER TABLE changed;\n');
      return commit;
    });
    const cli = vi.fn();
    await expectFailureCode(
      runDatabaseMigration(
        input({ operation: 'apply', expectedManifest: initialManifest }),
        context(),
        {
          ...baseDependencies(source, { runGate }),
          temporaryDirectory: root,
          cli: await pinnedCli(root),
          runCli: cli,
        },
      ),
      'MIGRATION_FILES_CHANGED',
    );
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(cli).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('uses only the staged reviewed SQL and reports before/after history metadata', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const cli = await pinnedCli(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const runPreflight = vi
      .fn<() => Promise<DevDatabasePreflightResult>>()
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(
        preflight({
          remoteVersions: [firstVersion, secondVersion],
          pendingMigrations: [],
        }),
      );
    const runCli = vi.fn(async ({ workdir, databasePassword: passedPassword }) => {
      expect(passedPassword).toBe(databasePassword);
      expect(await readdir(workdir)).toEqual(['supabase']);
      expect((await readdir(join(workdir, 'supabase'))).sort()).toEqual([
        'config.toml',
        'migrations',
      ]);
      expect((await readdir(join(workdir, 'supabase', 'migrations'))).sort()).toEqual(
        allMigrations.map(({ filename }) => filename).sort(),
      );
      expect(await readFile(join(workdir, 'supabase', 'config.toml'), 'utf8')).toContain(
        'enabled = false',
      );
      expect(
        await readFile(join(workdir, 'supabase', 'migrations', secondMigration.filename), 'utf8'),
      ).toBe(secondSource);
    });
    const result = await runDatabaseMigration(
      input({ operation: 'apply', expectedManifest: initialManifest }),
      context(),
      {
        ...baseDependencies(source, { runPreflight }),
        temporaryDirectory: root,
        cli,
        runCli,
      },
    );

    expect(result.operation).toBe('apply');
    expect(result.outcome).toBe('applied');
    expect(result.remoteVersionsBefore).toEqual([firstVersion]);
    expect(result.remoteVersionsAfter).toEqual([firstVersion, secondVersion]);
    expect(result.pendingMigrations).toEqual([secondMigration]);
    expect(result.databaseWriteAttempted).toBe(true);
    expect(renderDatabaseMigrationSummary(result)).toContain('Database write attempted: yes');
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('skips the CLI when all local versions are already present', async () => {
    const source = await migrationDirectory();
    const complete = preflight({
      remoteVersions: [firstVersion, secondVersion],
      pendingMigrations: [],
    });
    const manifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(complete, allMigrations),
    );
    const runCli = vi.fn();
    const result = await runDatabaseMigration(
      input({ operation: 'apply', expectedManifest: manifest }),
      context(),
      {
        ...baseDependencies(source, { runPreflight: vi.fn(async () => complete) }),
        runCli,
      },
    );
    expect(result.outcome).toBe('already-current');
    expect(result.databaseWriteAttempted).toBe(false);
    expect(result.remoteVersionsAfter).toEqual([firstVersion, secondVersion]);
    expect(runCli).not.toHaveBeenCalled();
  });

  it('fails if the CLI returns successfully but remote migration history is still pending', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const runPreflight = vi
      .fn<() => Promise<DevDatabasePreflightResult>>()
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight());
    const runCli = vi.fn(async () => undefined);
    await expectFailureCode(
      runDatabaseMigration(
        input({ operation: 'apply', expectedManifest: initialManifest }),
        context(),
        {
          ...baseDependencies(source, { runPreflight }),
          temporaryDirectory: root,
          cli: await pinnedCli(root),
          runCli,
        },
      ),
      'POST_APPLY_VERIFICATION_FAILED',
      true,
    );
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('reports an unknown write result and cleans up when the CLI fails', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const runCli = vi.fn(async () => {
      throw new Error('raw CLI output and password must not escape');
    });

    const failure = await runDatabaseMigration(
      input({ operation: 'apply', expectedManifest: initialManifest }),
      context(),
      {
        ...baseDependencies(source),
        temporaryDirectory: root,
        cli: await pinnedCli(root),
        runCli,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: 'CLI_WRITE_RESULT_UNKNOWN',
      databaseWriteAttempted: true,
      message: 'CLI_WRITE_RESULT_UNKNOWN',
    });
    expect((failure as Error).message).not.toContain(databasePassword);
    expect((failure as Error).message).not.toContain('raw CLI output');
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('treats a stale-head postflight as an attempted write and never preserves its raw error', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const runPreflight = vi
      .fn<() => Promise<DevDatabasePreflightResult>>()
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight())
      .mockRejectedValueOnce(new DevDatabasePreflightFailure('GITHUB_HEAD_STALE'));
    const runCli = vi.fn(async () => undefined);

    const failure = await runDatabaseMigration(
      input({ operation: 'apply', expectedManifest: initialManifest }),
      context(),
      {
        ...baseDependencies(source, { runPreflight }),
        temporaryDirectory: root,
        cli: await pinnedCli(root),
        runCli,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: 'POST_APPLY_VERIFICATION_FAILED',
      databaseWriteAttempted: true,
      message: 'POST_APPLY_VERIFICATION_FAILED',
    });
    expect((failure as Error).message).not.toContain('GITHUB_HEAD_STALE');
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('stops before CLI execution if the remote history changes after plan review', async () => {
    const source = await migrationDirectory();
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const initialManifest = hashDatabaseMigrationManifest(
      createDatabaseMigrationManifest(preflight(), allMigrations),
    );
    const changedHistory = preflight({
      remoteVersions: [firstVersion, secondVersion],
      pendingMigrations: [],
    });
    const runPreflight = vi
      .fn<() => Promise<DevDatabasePreflightResult>>()
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(changedHistory);
    const runCli = vi.fn();

    await expectFailureCode(
      runDatabaseMigration(
        input({ operation: 'apply', expectedManifest: initialManifest }),
        context(),
        {
          ...baseDependencies(source, { runPreflight }),
          temporaryDirectory: root,
          cli: await pinnedCli(root),
          runCli,
        },
      ),
      'MIGRATION_HISTORY_CHANGED',
    );
    expect(runCli).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['manga-nikki-supabase-cli-v2.122.0']);
  });

  it('rejects an altered Supabase CLI or sidecar before apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manga-nikki-db-migration-cli-root-'));
    temporaryDirectories.push(root);
    const cli = await pinnedCli(root);
    await writeFile(cli.cliPath, 'changed binary', { mode: 0o700 });
    await expectFailureCode(
      Promise.resolve().then(() => validatePinnedSupabaseCli(cli)),
      'CLI_BINARY_INVALID',
    );
  });
});
