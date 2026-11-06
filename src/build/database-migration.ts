import { constants } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEV_DATABASE_MIGRATIONS_DIRECTORY,
  DEV_DATABASE_PROJECT_REF,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  readLocalMigrations,
  runDevDatabasePreflight,
  runDevDatabasePreflightGate,
  verifyPinnedRootCertificate,
  type DevDatabasePreflightContext,
  type DevDatabasePreflightResult,
  type LocalMigration,
} from './dev-database-preflight.ts';
import { runSupabaseDbPush } from './database-migration-runner.ts';

const MANIFEST_SHA_PATTERN = /^[0-9a-f]{64}$/i;
const SUPABASE_CLI_DIRECTORY_NAME = 'manga-nikki-supabase-cli-v2.122.0';
const MINIMAL_SUPABASE_CONFIG = [
  'project_id = "manga-nikki-db-migration"',
  '',
  '[db.seed]',
  'enabled = false',
  '',
].join('\n');

export type DatabaseMigrationOperation = 'plan' | 'apply';

export type DatabaseMigrationInput = Readonly<{
  operation: string | undefined;
  expectedManifest: string | undefined;
  runAttempt?: string;
}>;

export type DatabaseMigrationErrorCode =
  | 'INPUT_OPERATION_INVALID'
  | 'INPUT_APPLY_RERUN_FORBIDDEN'
  | 'INPUT_MANIFEST_REQUIRED'
  | 'INPUT_MANIFEST_INVALID'
  | 'EXPECTED_MANIFEST_MISMATCH'
  | 'MIGRATION_FILES_CHANGED'
  | 'MIGRATION_HISTORY_CHANGED'
  | 'POST_APPLY_STATE_INVALID'
  | 'CLI_WRITE_RESULT_UNKNOWN'
  | 'POST_APPLY_VERIFICATION_FAILED'
  | 'CLI_CONFIGURATION_INVALID'
  | 'CLI_BINARY_INVALID'
  | 'CLI_SIDECAR_INVALID'
  | 'TEMP_WORKDIR_FAILED'
  | 'MIGRATION_STAGE_FAILED';

export class DatabaseMigrationFailure extends Error {
  readonly code: DatabaseMigrationErrorCode;
  readonly databaseWriteAttempted: boolean;

  constructor(code: DatabaseMigrationErrorCode, databaseWriteAttempted = false) {
    super(code);
    this.name = 'DatabaseMigrationFailure';
    this.code = code;
    this.databaseWriteAttempted = databaseWriteAttempted;
  }
}

export type DatabaseMigrationManifest = Readonly<{
  projectRef: string;
  sourceCommit: string;
  remoteVersions: readonly string[];
  localMigrations: readonly LocalMigration[];
}>;

export type DatabaseMigrationMetadata = Readonly<{
  operation: DatabaseMigrationOperation;
  outcome: 'planned' | 'applied' | 'already-current';
  projectRef: string;
  sourceCommit: string;
  manifestSha256: string;
  migrationHistory: 'present' | 'absent';
  databaseWriteAttempted: boolean;
  remoteVersionsBefore: readonly string[];
  remoteVersionsAfter: readonly string[] | null;
  localMigrations: readonly LocalMigration[];
  pendingMigrations: readonly LocalMigration[];
}>;

export type PinnedCliConfiguration = Readonly<{
  runnerTemporaryDirectory: string;
  cliPath: string;
  cliSha256: string;
  sidecarPath: string;
  sidecarSha256: string;
}>;

type Preflight = (context: DevDatabasePreflightContext) => Promise<DevDatabasePreflightResult>;
type ReadMigrations = (directory?: string) => Promise<LocalMigration[]>;

export type DatabaseMigrationDependencies = Readonly<{
  runPreflight?: Preflight;
  runGate?: (context: DevDatabasePreflightContext) => Promise<string>;
  verifyCertificate?: (path: string) => Promise<void>;
  readMigrations?: ReadMigrations;
  migrationsDirectory?: string;
  certificatePath?: string;
  temporaryDirectory?: string;
  cli?: PinnedCliConfiguration;
  mkdtemp?: typeof mkdtemp;
  mkdir?: typeof mkdir;
  open?: typeof open;
  lstat?: typeof lstat;
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  removeDirectory?: typeof rm;
  runCli?: typeof runSupabaseDbPush;
}>;

function fail(code: DatabaseMigrationErrorCode, databaseWriteAttempted = false): never {
  throw new DatabaseMigrationFailure(code, databaseWriteAttempted);
}

export function validateDatabaseMigrationInput(
  input: DatabaseMigrationInput,
): Readonly<{ operation: DatabaseMigrationOperation; expectedManifest?: string }> {
  if (input.operation !== 'plan' && input.operation !== 'apply') {
    return fail('INPUT_OPERATION_INVALID');
  }
  if (input.operation === 'apply' && input.runAttempt !== '1') {
    return fail('INPUT_APPLY_RERUN_FORBIDDEN');
  }
  const expectedManifest = input.expectedManifest?.trim() ?? '';
  if (input.operation === 'apply' && expectedManifest.length === 0) {
    return fail('INPUT_MANIFEST_REQUIRED');
  }
  if (expectedManifest && !MANIFEST_SHA_PATTERN.test(expectedManifest)) {
    return fail('INPUT_MANIFEST_INVALID');
  }
  return input.operation === 'apply'
    ? { operation: input.operation, expectedManifest: expectedManifest.toLowerCase() }
    : expectedManifest
      ? { operation: input.operation, expectedManifest: expectedManifest.toLowerCase() }
      : { operation: input.operation };
}

export function createDatabaseMigrationManifest(
  result: Pick<DevDatabasePreflightResult, 'commit' | 'remoteVersions'>,
  localMigrations: readonly LocalMigration[],
): DatabaseMigrationManifest {
  return {
    projectRef: DEV_DATABASE_PROJECT_REF,
    sourceCommit: result.commit,
    remoteVersions: [...result.remoteVersions],
    localMigrations: localMigrations.map(({ version, filename, sha256 }) => ({
      version,
      filename,
      sha256,
    })),
  };
}

export function hashDatabaseMigrationManifest(manifest: DatabaseMigrationManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function sameMigrations(
  left: readonly LocalMigration[],
  right: readonly LocalMigration[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (migration, index) =>
        migration.version === right[index]?.version &&
        migration.filename === right[index]?.filename &&
        migration.sha256 === right[index]?.sha256,
    )
  );
}

function sameVersions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((version, index) => version === right[index]);
}

function assertPreflightMatchesLocalFiles(
  result: DevDatabasePreflightResult,
  localMigrations: readonly LocalMigration[],
): void {
  if (
    result.remoteVersions.length > localMigrations.length ||
    result.remoteVersions.some((version, index) => version !== localMigrations[index]?.version) ||
    !sameMigrations(result.pendingMigrations, localMigrations.slice(result.remoteVersions.length))
  ) {
    return fail('MIGRATION_FILES_CHANGED');
  }
}

export async function validatePinnedSupabaseCli(
  configuration: PinnedCliConfiguration,
  dependencies: Pick<DatabaseMigrationDependencies, 'lstat' | 'readFile'> = {},
): Promise<void> {
  const expectedDirectory = join(
    resolve(configuration.runnerTemporaryDirectory),
    SUPABASE_CLI_DIRECTORY_NAME,
  );
  const expectedCliPath = join(expectedDirectory, 'supabase');
  const expectedSidecarPath = join(expectedDirectory, 'supabase-go');
  if (
    resolve(configuration.cliPath) !== expectedCliPath ||
    resolve(configuration.sidecarPath) !== expectedSidecarPath ||
    !MANIFEST_SHA_PATTERN.test(configuration.cliSha256) ||
    !MANIFEST_SHA_PATTERN.test(configuration.sidecarSha256)
  ) {
    return fail('CLI_CONFIGURATION_INVALID');
  }

  const lstatFile = dependencies.lstat ?? lstat;
  const read = dependencies.readFile ?? readFile;
  for (const [path, expectedHash, errorCode] of [
    [configuration.cliPath, configuration.cliSha256, 'CLI_BINARY_INVALID'],
    [configuration.sidecarPath, configuration.sidecarSha256, 'CLI_SIDECAR_INVALID'],
  ] as const) {
    try {
      const info = await lstatFile(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
        return fail(errorCode);
      }
      const actualHash = createHash('sha256')
        .update(await read(path))
        .digest('hex');
      if (actualHash !== expectedHash.toLowerCase()) return fail(errorCode);
    } catch {
      return fail(errorCode);
    }
  }
}

async function readMigrationContents(path: string, openFile: typeof open): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile()) return fail('MIGRATION_STAGE_FAILED');
    return await file.readFile();
  } catch {
    return fail('MIGRATION_STAGE_FAILED');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function stageMigrations(
  workdir: string,
  sourceMigrationsDirectory: string,
  migrations: readonly LocalMigration[],
  dependencies: Required<
    Pick<DatabaseMigrationDependencies, 'mkdir' | 'open' | 'writeFile' | 'readFile'>
  >,
): Promise<void> {
  const supabaseDirectory = join(workdir, 'supabase');
  const stagedMigrationsDirectory = join(supabaseDirectory, 'migrations');
  try {
    await dependencies.mkdir(stagedMigrationsDirectory, { recursive: true, mode: 0o700 });
    await dependencies.writeFile(join(supabaseDirectory, 'config.toml'), MINIMAL_SUPABASE_CONFIG, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    for (const migration of migrations) {
      const sourcePath = join(sourceMigrationsDirectory, migration.filename);
      const content = await readMigrationContents(sourcePath, dependencies.open);
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== migration.sha256) return fail('MIGRATION_FILES_CHANGED');
      await dependencies.writeFile(join(stagedMigrationsDirectory, migration.filename), content, {
        mode: 0o600,
        flag: 'wx',
      });
      const stagedContent = await dependencies.readFile(
        join(stagedMigrationsDirectory, migration.filename),
      );
      if (createHash('sha256').update(stagedContent).digest('hex') !== migration.sha256) {
        return fail('MIGRATION_STAGE_FAILED');
      }
    }
  } catch (error) {
    if (error instanceof DatabaseMigrationFailure) throw error;
    return fail('MIGRATION_STAGE_FAILED');
  }
}

function metadata(
  operation: DatabaseMigrationOperation,
  outcome: DatabaseMigrationMetadata['outcome'],
  result: DevDatabasePreflightResult,
  manifestHash: string,
  localMigrations: readonly LocalMigration[],
  remoteVersionsAfter: readonly string[] | null,
  databaseWriteAttempted: boolean,
): DatabaseMigrationMetadata {
  return {
    operation,
    outcome,
    projectRef: DEV_DATABASE_PROJECT_REF,
    sourceCommit: result.commit,
    manifestSha256: manifestHash,
    migrationHistory: result.migrationHistory,
    databaseWriteAttempted,
    remoteVersionsBefore: [...result.remoteVersions],
    remoteVersionsAfter: remoteVersionsAfter ? [...remoteVersionsAfter] : null,
    localMigrations: localMigrations.map(({ version, filename, sha256 }) => ({
      version,
      filename,
      sha256,
    })),
    pendingMigrations: result.pendingMigrations.map(({ version, filename, sha256 }) => ({
      version,
      filename,
      sha256,
    })),
  };
}

export async function runDatabaseMigration(
  input: DatabaseMigrationInput,
  context: DevDatabasePreflightContext,
  dependencies: DatabaseMigrationDependencies = {},
): Promise<DatabaseMigrationMetadata> {
  const validatedInput = validateDatabaseMigrationInput(input);
  const preflight = dependencies.runPreflight ?? runDevDatabasePreflight;
  const listMigrations = dependencies.readMigrations ?? readLocalMigrations;
  const migrationsDirectory = dependencies.migrationsDirectory ?? DEV_DATABASE_MIGRATIONS_DIRECTORY;
  const before = await preflight(context);
  const migrations = await listMigrations(migrationsDirectory);
  assertPreflightMatchesLocalFiles(before, migrations);

  const manifest = createDatabaseMigrationManifest(before, migrations);
  const manifestSha256 = hashDatabaseMigrationManifest(manifest);
  if (validatedInput.operation === 'apply' && validatedInput.expectedManifest !== manifestSha256) {
    return fail('EXPECTED_MANIFEST_MISMATCH');
  }

  if (validatedInput.operation === 'plan') {
    return metadata('plan', 'planned', before, manifestSha256, migrations, null, false);
  }

  if (before.pendingMigrations.length === 0) {
    const after = await preflight(context);
    const afterMigrations = await listMigrations(migrationsDirectory);
    assertPreflightMatchesLocalFiles(after, afterMigrations);
    if (after.commit !== before.commit || !sameMigrations(afterMigrations, migrations)) {
      return fail('MIGRATION_FILES_CHANGED');
    }
    if (
      !sameVersions(
        after.remoteVersions,
        migrations.map(({ version }) => version),
      )
    ) {
      return fail('POST_APPLY_STATE_INVALID');
    }
    return metadata(
      'apply',
      'already-current',
      before,
      manifestSha256,
      migrations,
      after.remoteVersions,
      false,
    );
  }

  if (!dependencies.cli) return fail('CLI_CONFIGURATION_INVALID');
  await validatePinnedSupabaseCli(dependencies.cli, dependencies);

  const createTempDirectory = dependencies.mkdtemp ?? mkdtemp;
  const createDirectory = dependencies.mkdir ?? mkdir;
  const openFile = dependencies.open ?? open;
  const write = dependencies.writeFile ?? writeFile;
  const read = dependencies.readFile ?? readFile;
  const removeDirectory = dependencies.removeDirectory ?? rm;
  const runCli = dependencies.runCli ?? runSupabaseDbPush;
  let workdir: string;
  try {
    workdir = await createTempDirectory(
      join(dependencies.temporaryDirectory ?? tmpdir(), 'manga-nikki-db-migrate-'),
    );
  } catch {
    return fail('TEMP_WORKDIR_FAILED');
  }

  try {
    await stageMigrations(workdir, migrationsDirectory, migrations, {
      mkdir: createDirectory,
      open: openFile,
      writeFile: write,
      readFile: read,
    });

    const applyCheck = await preflight(context);
    if (!sameVersions(applyCheck.remoteVersions, before.remoteVersions)) {
      return fail('MIGRATION_HISTORY_CHANGED');
    }
    if (applyCheck.commit !== before.commit) return fail('MIGRATION_FILES_CHANGED');
    const applyCheckMigrations = await listMigrations(migrationsDirectory);
    assertPreflightMatchesLocalFiles(applyCheck, applyCheckMigrations);
    if (!sameMigrations(applyCheckMigrations, migrations)) {
      return fail('MIGRATION_FILES_CHANGED');
    }

    const gate = dependencies.runGate ?? runDevDatabasePreflightGate;
    await gate(context);
    const verifyCertificate = dependencies.verifyCertificate ?? verifyPinnedRootCertificate;
    await verifyCertificate(dependencies.certificatePath ?? DEV_DATABASE_ROOT_CERTIFICATE_PATH);
    const latestMigrations = await listMigrations(migrationsDirectory);
    if (!sameMigrations(latestMigrations, migrations)) return fail('MIGRATION_FILES_CHANGED');

    for (const migration of latestMigrations) {
      const stagedPath = join(workdir, 'supabase', 'migrations', migration.filename);
      let stagedContent: Buffer;
      try {
        stagedContent = await read(stagedPath);
      } catch {
        return fail('MIGRATION_STAGE_FAILED');
      }
      if (createHash('sha256').update(stagedContent).digest('hex') !== migration.sha256) {
        return fail('MIGRATION_STAGE_FAILED');
      }
    }

    try {
      await runCli({
        cliPath: dependencies.cli.cliPath,
        workdir,
        databasePassword: context.databasePassword ?? '',
      });
    } catch {
      return fail('CLI_WRITE_RESULT_UNKNOWN', true);
    }

    try {
      const after = await preflight(context);
      const afterMigrations = await listMigrations(migrationsDirectory);
      assertPreflightMatchesLocalFiles(after, afterMigrations);
      if (after.commit !== before.commit || !sameMigrations(afterMigrations, migrations)) {
        return fail('POST_APPLY_VERIFICATION_FAILED', true);
      }
      if (
        after.pendingMigrations.length !== 0 ||
        !sameVersions(
          after.remoteVersions,
          migrations.map(({ version }) => version),
        )
      ) {
        return fail('POST_APPLY_VERIFICATION_FAILED', true);
      }

      return metadata(
        'apply',
        'applied',
        before,
        manifestSha256,
        migrations,
        after.remoteVersions,
        true,
      );
    } catch {
      return fail('POST_APPLY_VERIFICATION_FAILED', true);
    }
  } finally {
    await removeDirectory(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function renderDatabaseMigrationSummary(result: DatabaseMigrationMetadata): string {
  const migrationList =
    result.localMigrations.length === 0
      ? '- なし'
      : result.localMigrations
          .map(
            (migration) =>
              `- \`${migration.version}\` \`${migration.filename}\` SHA-256 \`${migration.sha256}\``,
          )
          .join('\n');
  const pendingList =
    result.pendingMigrations.length === 0
      ? '- なし'
      : result.pendingMigrations
          .map(
            (migration) =>
              `- \`${migration.version}\` \`${migration.filename}\` SHA-256 \`${migration.sha256}\``,
          )
          .join('\n');
  const remoteAfter = result.remoteVersionsAfter
    ? result.remoteVersionsAfter.join(', ') || 'なし'
    : '未確認';
  return [
    '## Supabase DB migration',
    '',
    `- Operation: \`${result.operation}\``,
    `- Outcome: \`${result.outcome}\``,
    `- Project ref: \`${result.projectRef}\``,
    `- Source commit: \`${result.sourceCommit}\``,
    `- Manifest SHA-256: \`${result.manifestSha256}\``,
    `- Migration history: ${result.migrationHistory === 'present' ? '存在' : '未作成'}`,
    `- Database write attempted: ${result.databaseWriteAttempted ? 'yes' : 'no'}`,
    `- Remote versions before: ${result.remoteVersionsBefore.join(', ') || 'なし'}`,
    `- Remote versions after: ${remoteAfter}`,
    '',
    '### Local migrations',
    '',
    migrationList,
    '',
    '### Pending migrations',
    '',
    pendingList,
    '',
    '- SQL本文・DB出力・接続情報・秘密情報は記録していません。',
    '',
  ].join('\n');
}

export async function runDatabaseMigrationGate(
  input: DatabaseMigrationInput,
  context: DevDatabasePreflightContext,
  runGate: (context: DevDatabasePreflightContext) => Promise<string> = runDevDatabasePreflightGate,
): Promise<void> {
  validateDatabaseMigrationInput(input);
  await runGate(context);
}
