import { createHash, X509Certificate } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PsqlProcessFailure, runPsqlReadOnlyQuery } from './dev-database-preflight-runner.ts';
import type { PsqlConnection } from './dev-database-preflight-runner.ts';

export const DEV_DATABASE_SETUP_REPOSITORY = 'tossyhal/manga-nikki';
export const DEV_DATABASE_SETUP_REF = 'refs/heads/main';
export const DEV_DATABASE_SETUP_ACTOR_ID = '92223710';
export const DEV_DATABASE_SETUP_TRIGGERING_ACTOR = 'tossyhal';
export const DEV_DATABASE_PROJECT_REF = 'leihsygtsamxffyybskh';
export const DEV_DATABASE_HOST = 'aws-0-ap-northeast-1.pooler.supabase.com';
export const DEV_DATABASE_PORT = '5432';
export const DEV_DATABASE_NAME = 'postgres';
export const DEV_DATABASE_USER = 'postgres.leihsygtsamxffyybskh';
export const DEV_DATABASE_APP_NAME = 'manga-nikki-dev-db-preflight';
export const DEV_DATABASE_ROOT_CA_SHA256 =
  '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
export const DEV_DATABASE_ROOT_CA_FINGERPRINT =
  '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEV_DATABASE_MIGRATIONS_DIRECTORY = `${PROJECT_ROOT}/supabase/migrations`;
export const DEV_DATABASE_ROOT_CERTIFICATE_PATH = `${PROJECT_ROOT}/supabase/certs/prod-ca-2021.crt`;
export const DEV_DATABASE_GITHUB_HEAD_URL = `https://api.github.com/repos/${DEV_DATABASE_SETUP_REPOSITORY}/branches/main`;

const MIGRATION_FILENAME_PATTERN = /^(\d{14})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_GITHUB_RESPONSE_BYTES = 32 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;

export type DevDatabasePreflightErrorCode =
  | 'INPUT_CONTEXT_INVALID'
  | 'INPUT_ACTOR_INVALID'
  | 'INPUT_SECRET_ID_INVALID'
  | 'INPUT_SHA_INVALID'
  | 'GITHUB_TOKEN_MISSING'
  | 'GITHUB_HEAD_REQUEST_FAILED'
  | 'GITHUB_HEAD_RESPONSE_INVALID'
  | 'GITHUB_HEAD_STALE'
  | 'DATABASE_PASSWORD_MISSING'
  | 'ROOT_CERTIFICATE_FILE_INVALID'
  | 'ROOT_CERTIFICATE_HASH_INVALID'
  | 'ROOT_CERTIFICATE_INVALID'
  | 'ROOT_CERTIFICATE_NOT_CURRENT'
  | 'LOCAL_MIGRATION_DIRECTORY_INVALID'
  | 'LOCAL_MIGRATION_FILE_INVALID'
  | 'LOCAL_MIGRATION_VERSION_DUPLICATE'
  | 'PSQL_START_FAILED'
  | 'PSQL_TIMEOUT'
  | 'PSQL_OUTPUT_TOO_LARGE'
  | 'PSQL_COMMAND_FAILED'
  | 'DATABASE_QUERY_FAILED'
  | 'DATABASE_CATALOG_INVALID'
  | 'DATABASE_IDENTITY_INVALID'
  | 'DATABASE_SESSION_INVALID'
  | 'DATABASE_PLATFORM_INVALID'
  | 'MIGRATION_HISTORY_READ_FAILED'
  | 'MIGRATION_HISTORY_INVALID'
  | 'MIGRATION_HISTORY_NOT_PREFIX'
  | 'APP_TABLES_WITHOUT_MIGRATION_HISTORY'
  | 'MIGRATION_HISTORY_WITHOUT_APPLICATION_TABLES';

export class DevDatabasePreflightFailure extends Error {
  readonly code: DevDatabasePreflightErrorCode;

  constructor(code: DevDatabasePreflightErrorCode) {
    super(code);
    this.name = 'DevDatabasePreflightFailure';
    this.code = code;
  }
}

export type DevDatabasePreflightContext = Readonly<{
  githubActions?: string;
  githubRepository?: string;
  githubRef?: string;
  githubEventName?: string;
  githubSha?: string;
  githubActorId?: string;
  githubTriggeringActor?: string;
  githubToken?: string;
  bwsSecretId?: string;
  databasePassword?: string;
}>;

export type LocalMigration = Readonly<{
  version: string;
  filename: string;
  sha256: string;
}>;

export type DevDatabasePreflightResult = Readonly<{
  commit: string;
  remoteVersions: readonly string[];
  migrationHistory: 'present' | 'absent';
  pendingMigrations: readonly LocalMigration[];
}>;

export type DevDatabasePreflightDependencies = Readonly<{
  fetcher?: typeof fetch;
  migrationsDirectory?: string;
  certificatePath?: string;
  now?: () => Date;
  runPsql?: (sql: string, password: string) => Promise<string>;
}>;

type ValidatedContext = Readonly<{
  commit: string;
  token: string;
}>;

type CatalogCheck = Readonly<{
  identityOk: boolean;
  sessionOk: boolean;
  platformOk: boolean;
  historyExists: boolean;
  publicTablesPresent: boolean;
  entriesPresent: boolean;
  generationsPresent: boolean;
}>;

const readOnlyTransactionSetupSql = [
  'SET LOCAL default_transaction_read_only=on;',
  "SET LOCAL statement_timeout='15s';",
  "SET LOCAL lock_timeout='5s';",
  'SET LOCAL search_path=pg_catalog;',
].join('\n');

const sessionSettingsCheckSql = `
pg_catalog.current_setting('transaction_read_only') = 'on'
  AND pg_catalog.current_setting('default_transaction_read_only') = 'on'
  AND pg_catalog.current_setting('statement_timeout') = '15s'
  AND pg_catalog.current_setting('lock_timeout') = '5s'
  AND pg_catalog.current_setting('search_path') = 'pg_catalog'
`.trim();

const connectionCheckSql = `
BEGIN READ ONLY;
${readOnlyTransactionSetupSql}
SELECT pg_catalog.json_build_object(
  'identityOk',
  pg_catalog.current_database() = 'postgres'
    AND current_user = 'postgres'
    AND pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE'),
  'sessionOk', ${sessionSettingsCheckSql},
  'platformOk',
    pg_catalog.to_regclass('auth.users') IS NOT NULL
    AND pg_catalog.to_regclass('storage.objects') IS NOT NULL
    AND (
      SELECT pg_catalog.count(*) = 3
      FROM pg_catalog.pg_roles
      WHERE rolname = ANY (ARRAY['anon', 'authenticated', 'service_role'])
    ),
  'historyExists', pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL,
  'publicTablesPresent', EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
  ),
  'entriesPresent', EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'entries'
      AND relation.relkind IN ('r', 'p')
  ),
  'generationsPresent', EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'generations'
      AND relation.relkind IN ('r', 'p')
  )
)::text;
ROLLBACK;
`.trim();

function fail(code: DevDatabasePreflightErrorCode): never {
  throw new DevDatabasePreflightFailure(code);
}

function validateSha(value: string | undefined): string {
  if (!value || !SHA_PATTERN.test(value)) return fail('INPUT_SHA_INVALID');
  return value.toLowerCase();
}

function validateContext(context: DevDatabasePreflightContext): ValidatedContext {
  if (
    context.githubActions !== 'true' ||
    context.githubRepository !== DEV_DATABASE_SETUP_REPOSITORY ||
    context.githubRef !== DEV_DATABASE_SETUP_REF ||
    context.githubEventName !== 'workflow_dispatch'
  ) {
    return fail('INPUT_CONTEXT_INVALID');
  }

  if (
    context.githubActorId !== DEV_DATABASE_SETUP_ACTOR_ID ||
    context.githubTriggeringActor !== DEV_DATABASE_SETUP_TRIGGERING_ACTOR
  ) {
    return fail('INPUT_ACTOR_INVALID');
  }

  const commit = validateSha(context.githubSha);
  if (!context.bwsSecretId || !UUID_PATTERN.test(context.bwsSecretId)) {
    return fail('INPUT_SECRET_ID_INVALID');
  }

  const token = context.githubToken;
  if (!token || token.trim() !== token || /[\r\n]/.test(token)) {
    return fail('GITHUB_TOKEN_MISSING');
  }

  return { commit, token };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail('GITHUB_HEAD_RESPONSE_INVALID');

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel();
        return fail('GITHUB_HEAD_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
  } catch {
    return fail('GITHUB_HEAD_RESPONSE_INVALID');
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(
    chunks.reduce((buffer, chunk) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      return joined;
    }, new Uint8Array()),
  );
}

async function fetchCurrentMainHead(token: string, fetcher: typeof fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(DEV_DATABASE_GITHUB_HEAD_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail('GITHUB_HEAD_REQUEST_FAILED');
  }

  if (!response.ok) return fail('GITHUB_HEAD_REQUEST_FAILED');

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedResponse(response));
  } catch (error) {
    if (error instanceof DevDatabasePreflightFailure) throw error;
    return fail('GITHUB_HEAD_RESPONSE_INVALID');
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('commit' in body) ||
    typeof body.commit !== 'object' ||
    body.commit === null ||
    !('sha' in body.commit) ||
    typeof body.commit.sha !== 'string' ||
    !SHA_PATTERN.test(body.commit.sha)
  ) {
    return fail('GITHUB_HEAD_RESPONSE_INVALID');
  }

  return body.commit.sha.toLowerCase();
}

export async function runDevDatabasePreflightGate(
  context: DevDatabasePreflightContext,
  dependencies: Pick<DevDatabasePreflightDependencies, 'fetcher'> = {},
): Promise<string> {
  const validated = validateContext(context);
  const head = await fetchCurrentMainHead(validated.token, dependencies.fetcher ?? fetch);
  if (head !== validated.commit) return fail('GITHUB_HEAD_STALE');
  return validated.commit;
}

export async function verifyPinnedRootCertificate(
  certificatePath: string = DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  now: Date = new Date(),
): Promise<void> {
  let certificate: Buffer;
  try {
    const fileInfo = await lstat(certificatePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_CERTIFICATE_BYTES) {
      return fail('ROOT_CERTIFICATE_FILE_INVALID');
    }
    certificate = await readFile(certificatePath);
  } catch {
    return fail('ROOT_CERTIFICATE_FILE_INVALID');
  }

  if (createHash('sha256').update(certificate).digest('hex') !== DEV_DATABASE_ROOT_CA_SHA256) {
    return fail('ROOT_CERTIFICATE_HASH_INVALID');
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certificate);
  } catch {
    return fail('ROOT_CERTIFICATE_INVALID');
  }

  const fingerprint = x509.fingerprint256.replaceAll(':', '').toLowerCase();
  if (fingerprint !== DEV_DATABASE_ROOT_CA_FINGERPRINT) return fail('ROOT_CERTIFICATE_INVALID');

  const validFrom = Date.parse(x509.validFrom);
  const validTo = Date.parse(x509.validTo);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    !Number.isFinite(nowMs) ||
    nowMs < validFrom ||
    nowMs >= validTo
  ) {
    return fail('ROOT_CERTIFICATE_NOT_CURRENT');
  }
}

export async function readLocalMigrations(
  migrationsDirectory: string = DEV_DATABASE_MIGRATIONS_DIRECTORY,
): Promise<LocalMigration[]> {
  let entries: Array<{
    name: string;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return fail('LOCAL_MIGRATION_DIRECTORY_INVALID');
  }

  const migrations: LocalMigration[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.sql')) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) return fail('LOCAL_MIGRATION_FILE_INVALID');

    const match = MIGRATION_FILENAME_PATTERN.exec(entry.name);
    if (!match) return fail('LOCAL_MIGRATION_FILE_INVALID');
    const version = match[1];
    if (!version) return fail('LOCAL_MIGRATION_FILE_INVALID');

    const filePath = `${migrationsDirectory}/${entry.name}`;
    try {
      const fileInfo = await lstat(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
        return fail('LOCAL_MIGRATION_FILE_INVALID');
      }
      const contents = await readFile(filePath);
      migrations.push({
        version,
        filename: entry.name,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    } catch (error) {
      if (error instanceof DevDatabasePreflightFailure) throw error;
      return fail('LOCAL_MIGRATION_FILE_INVALID');
    }
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version));
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index]?.version === migrations[index - 1]?.version) {
      return fail('LOCAL_MIGRATION_VERSION_DUPLICATE');
    }
  }
  return migrations;
}

export function buildPendingMigrationPlan(
  localMigrations: readonly LocalMigration[],
  remoteVersions: readonly string[],
  historyExists: boolean,
  tables: Pick<CatalogCheck, 'publicTablesPresent' | 'entriesPresent' | 'generationsPresent'>,
): LocalMigration[] {
  if ((!historyExists || remoteVersions.length === 0) && tables.publicTablesPresent) {
    return fail('APP_TABLES_WITHOUT_MIGRATION_HISTORY');
  }

  if (remoteVersions.some((version) => !/^\d{14}$/.test(version))) {
    return fail('MIGRATION_HISTORY_INVALID');
  }
  if (new Set(remoteVersions).size !== remoteVersions.length) {
    return fail('MIGRATION_HISTORY_INVALID');
  }
  if (remoteVersions.length > 0 && (!tables.entriesPresent || !tables.generationsPresent)) {
    return fail('MIGRATION_HISTORY_WITHOUT_APPLICATION_TABLES');
  }
  if (
    remoteVersions.length > localMigrations.length ||
    remoteVersions.some((version, index) => version !== localMigrations[index]?.version)
  ) {
    return fail('MIGRATION_HISTORY_NOT_PREFIX');
  }

  return localMigrations.slice(remoteVersions.length);
}

function parseCatalogResult(raw: string): CatalogCheck {
  let parsed: unknown;
  try {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.length === 0 || line.includes('\n') || line.includes('\r')) {
      return fail('DATABASE_CATALOG_INVALID');
    }
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof DevDatabasePreflightFailure) throw error;
    return fail('DATABASE_CATALOG_INVALID');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('identityOk' in parsed) ||
    typeof parsed.identityOk !== 'boolean' ||
    !('sessionOk' in parsed) ||
    typeof parsed.sessionOk !== 'boolean' ||
    !('platformOk' in parsed) ||
    typeof parsed.platformOk !== 'boolean' ||
    !('historyExists' in parsed) ||
    typeof parsed.historyExists !== 'boolean' ||
    !('publicTablesPresent' in parsed) ||
    typeof parsed.publicTablesPresent !== 'boolean' ||
    !('entriesPresent' in parsed) ||
    typeof parsed.entriesPresent !== 'boolean' ||
    !('generationsPresent' in parsed) ||
    typeof parsed.generationsPresent !== 'boolean'
  ) {
    return fail('DATABASE_CATALOG_INVALID');
  }

  return {
    identityOk: parsed.identityOk,
    sessionOk: parsed.sessionOk,
    platformOk: parsed.platformOk,
    historyExists: parsed.historyExists,
    publicTablesPresent: parsed.publicTablesPresent,
    entriesPresent: parsed.entriesPresent,
    generationsPresent: parsed.generationsPresent,
  };
}

function parseMigrationHistoryResult(raw: string): { sessionOk: boolean; versions: string[] } {
  let parsed: unknown;
  try {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.length === 0 || line.includes('\n') || line.includes('\r')) {
      return fail('MIGRATION_HISTORY_INVALID');
    }
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof DevDatabasePreflightFailure) throw error;
    return fail('MIGRATION_HISTORY_INVALID');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('sessionOk' in parsed) ||
    typeof parsed.sessionOk !== 'boolean' ||
    !('versions' in parsed) ||
    !Array.isArray(parsed.versions) ||
    parsed.versions.some((version) => typeof version !== 'string')
  ) {
    return fail('MIGRATION_HISTORY_INVALID');
  }

  return { sessionOk: parsed.sessionOk, versions: parsed.versions };
}

function parseRemoteVersions(versions: readonly string[]): string[] {
  if (versions.some((version) => !/^\d{14}$/.test(version))) {
    return fail('MIGRATION_HISTORY_INVALID');
  }
  if (new Set(versions).size !== versions.length) return fail('MIGRATION_HISTORY_INVALID');
  return [...versions];
}

function makePsqlConnection(password: string): PsqlConnection {
  return {
    host: DEV_DATABASE_HOST,
    port: DEV_DATABASE_PORT,
    database: DEV_DATABASE_NAME,
    user: DEV_DATABASE_USER,
    password,
    sslRootCert: DEV_DATABASE_ROOT_CERTIFICATE_PATH,
    appName: DEV_DATABASE_APP_NAME,
  };
}

function buildMigrationHistorySql(limit: number): string {
  return `
BEGIN READ ONLY;
${readOnlyTransactionSetupSql}
SELECT pg_catalog.json_build_object(
  'sessionOk', ${sessionSettingsCheckSql},
  'versions', COALESCE(
    (
      SELECT pg_catalog.json_agg(version ORDER BY version)
      FROM (
        SELECT version
        FROM supabase_migrations.schema_migrations
        ORDER BY version
        LIMIT ${limit}
      ) AS migration_versions
    ),
    '[]'::json
  )
)::text;
ROLLBACK;
`.trim();
}

export async function runDevDatabasePreflight(
  context: DevDatabasePreflightContext,
  dependencies: DevDatabasePreflightDependencies = {},
): Promise<DevDatabasePreflightResult> {
  const commit = await runDevDatabasePreflightGate(context, dependencies);
  const password = context.databasePassword;
  if (!password) return fail('DATABASE_PASSWORD_MISSING');

  await verifyPinnedRootCertificate(
    dependencies.certificatePath ?? DEV_DATABASE_ROOT_CERTIFICATE_PATH,
    dependencies.now?.() ?? new Date(),
  );
  const localMigrations = await readLocalMigrations(
    dependencies.migrationsDirectory ?? DEV_DATABASE_MIGRATIONS_DIRECTORY,
  );
  const psql =
    dependencies.runPsql ??
    (async (sql: string, secret: string) =>
      await runPsqlReadOnlyQuery(sql, { connection: makePsqlConnection(secret) }));

  let catalog: CatalogCheck;
  try {
    catalog = parseCatalogResult(await psql(connectionCheckSql, password));
  } catch (error) {
    if (error instanceof DevDatabasePreflightFailure) throw error;
    if (error instanceof PsqlProcessFailure) return fail(error.code);
    return fail('DATABASE_QUERY_FAILED');
  }
  if (!catalog.identityOk) return fail('DATABASE_IDENTITY_INVALID');
  if (!catalog.sessionOk) return fail('DATABASE_SESSION_INVALID');
  if (!catalog.platformOk) return fail('DATABASE_PLATFORM_INVALID');

  let remoteVersions: string[] = [];
  if (catalog.historyExists) {
    try {
      const rawHistory = await psql(buildMigrationHistorySql(localMigrations.length + 1), password);
      const history = parseMigrationHistoryResult(rawHistory);
      if (!history.sessionOk) return fail('DATABASE_SESSION_INVALID');
      remoteVersions = parseRemoteVersions(history.versions);
    } catch (error) {
      if (error instanceof DevDatabasePreflightFailure) throw error;
      if (error instanceof PsqlProcessFailure) return fail('MIGRATION_HISTORY_READ_FAILED');
      return fail('MIGRATION_HISTORY_READ_FAILED');
    }
  }

  const pendingMigrations = buildPendingMigrationPlan(
    localMigrations,
    remoteVersions,
    catalog.historyExists,
    catalog,
  );

  return {
    commit,
    remoteVersions,
    migrationHistory: catalog.historyExists ? 'present' : 'absent',
    pendingMigrations,
  };
}

export function renderDevDatabasePreflightSummary(result: DevDatabasePreflightResult): string {
  const remoteSummary =
    result.remoteVersions.length > 0 ? result.remoteVersions.join(', ') : 'なし';
  const pendingSummary =
    result.pendingMigrations.length > 0
      ? result.pendingMigrations
          .map((migration) => `  - \`${migration.filename}\` — SHA-256 \`${migration.sha256}\``)
          .join('\n')
      : '  - なし';

  return [
    '## 開発Supabase DB読み取り確認',
    '',
    `- Project ref: \`${DEV_DATABASE_PROJECT_REF}\``,
    `- Host: \`${DEV_DATABASE_HOST}\``,
    `- Workflow ref: \`${DEV_DATABASE_SETUP_REF}\``,
    `- Commit: \`${result.commit}\``,
    '- Local pending manifestは上記main commit内のmigrationだけです。develop全体や将来の適用対象を表しません。',
    '- 接続・catalog読み取り: 成功（read-only）',
    `- Migration history: ${result.migrationHistory === 'present' ? '存在' : '未作成（DDLは実行していません）'}`,
    `- Remote migration versions: ${remoteSummary}`,
    '- Local pending migrations:',
    pendingSummary,
    '- この操作によるmigration未適用、Auth・Storage設定未変更、Worker未変更',
    '- この結果はRLS動作検証完了や公開可能を意味しません。',
    '',
  ].join('\n');
}
