import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runDevDatabasePreflightGate,
  verifyPinnedRootCertificate,
  DEV_DATABASE_HOST,
  DEV_DATABASE_PORT,
  DEV_DATABASE_NAME,
  DEV_DATABASE_USER,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
} from './dev-database-preflight.ts';
import {
  createPsqlEnvironment,
  DEV_DATABASE_PSQL_PATH,
  runPsqlReadOnlyQuery,
} from './dev-database-preflight-runner.ts';

export type TrialPolicyOperation = 'check' | 'prepare' | 'enable' | 'stop';
type Code =
  | 'TRIAL_POLICY_INPUT_INVALID'
  | 'TRIAL_POLICY_METADATA_INVALID'
  | 'TRIAL_POLICY_STATE_INVALID'
  | 'TRIAL_POLICY_QUERY_FAILED'
  | 'TRIAL_POLICY_WRITE_RESULT_UNKNOWN';
export type TrialPolicyWriteCause =
  | 'TRIAL_POLICY_CONTEXT_INVALID'
  | 'TRIAL_POLICY_STATE_INVALID'
  | 'TRIAL_POLICY_HISTORY_NOT_EMPTY'
  | 'TRIAL_PROFILE_INVALID'
  | 'TRIAL_PROVIDER_COST_NOT_VERIFIED'
  | 'READ_ONLY_TRANSACTION'
  | 'COMMIT_MARKER_MISSING'
  | 'TEMPORARY_FILE_CLEANUP_FAILED'
  | 'UNKNOWN';
export class TrialPolicyFailure extends Error {
  readonly code: Code;
  readonly writeCause?: TrialPolicyWriteCause;
  constructor(code: Code, writeCause?: TrialPolicyWriteCause) {
    super(code);
    this.code = code;
    this.writeCause = writeCause;
  }
}
export const TRIAL_POLICY_CONFIRMATIONS = {
  prepare: 'PREPARE_ONE_COMIC_1USD_TRIAL',
  enable: 'ENABLE_ONE_COMIC_1USD_TRIAL_AFTER_VERIFIED_COST',
  stop: 'STOP_GENERATION',
} as const;
const execute = promisify(execFile);
export const TRIAL_POLICY_WRITE_PATH = fileURLToPath(
  new URL('../../supabase/operations/production-trial-policy-write.sql', import.meta.url),
);
export type TrialPolicyStatus = Readonly<{
  enabled: boolean;
  initialPolicy: boolean;
  trialPrepared: boolean;
  historyEmpty: boolean;
  policyTriggerPresent: boolean;
}>;
export function validateTrialPolicyInput(env: NodeJS.ProcessEnv): TrialPolicyOperation {
  const operation = env.PRODUCTION_TRIAL_POLICY_OPERATION;
  if (!['check', 'prepare', 'enable', 'stop'].includes(operation ?? ''))
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  if (
    operation !== 'check' &&
    (env.GITHUB_RUN_ATTEMPT !== '1' ||
      env.PRODUCTION_TRIAL_POLICY_CONFIRMATION !==
        TRIAL_POLICY_CONFIRMATIONS[operation as keyof typeof TRIAL_POLICY_CONFIRMATIONS])
  )
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  if (operation === 'enable' && env.PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED !== 'true')
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  if (env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID !== '6d238b9e-fdaf-497a-afef-b4f9011f9d33')
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  return operation as TrialPolicyOperation;
}
export async function gateTrialPolicy(env: NodeJS.ProcessEnv): Promise<TrialPolicyOperation> {
  const operation = validateTrialPolicyInput(env);
  await runDevDatabasePreflightGate({
    githubActions: env.GITHUB_ACTIONS,
    githubRepository: env.GITHUB_REPOSITORY,
    githubRef: env.GITHUB_REF,
    githubEventName: env.GITHUB_EVENT_NAME,
    githubSha: env.GITHUB_SHA,
    githubActorId: env.GITHUB_ACTOR_ID,
    githubTriggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    githubToken: env.GITHUB_TOKEN,
    bwsSecretId: env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID,
  });
  return operation;
}
function connection(password: string) {
  if (!password) throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  return {
    host: DEV_DATABASE_HOST,
    port: DEV_DATABASE_PORT,
    database: DEV_DATABASE_NAME,
    user: DEV_DATABASE_USER,
    password,
    sslRootCert: DEV_DATABASE_ROOT_CERTIFICATE_PATH,
    appName: 'manga-nikki-first-generation-trial-policy',
  };
}
export function parseTrialPolicyStatus(raw: string): TrialPolicyStatus {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new TrialPolicyFailure('TRIAL_POLICY_METADATA_INVALID');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new TrialPolicyFailure('TRIAL_POLICY_METADATA_INVALID');
  const value = data as Record<string, unknown>;
  if (
    value.identityOk !== true ||
    value.readOnly !== true ||
    value.policyExists !== true ||
    ['enabled', 'initialPolicy', 'trialPrepared', 'historyEmpty', 'policyTriggerPresent'].some(
      (key) => typeof value[key] !== 'boolean',
    )
  )
    throw new TrialPolicyFailure('TRIAL_POLICY_METADATA_INVALID');
  return {
    enabled: value.enabled as boolean,
    initialPolicy: value.initialPolicy as boolean,
    trialPrepared: value.trialPrepared as boolean,
    historyEmpty: value.historyEmpty as boolean,
    policyTriggerPresent: value.policyTriggerPresent as boolean,
  };
}
export async function readTrialPolicyStatus(password: string): Promise<TrialPolicyStatus> {
  await verifyPinnedRootCertificate(DEV_DATABASE_ROOT_CERTIFICATE_PATH, new Date());
  const sql = await readFile(
    fileURLToPath(
      new URL('../../supabase/operations/production-trial-policy-check.sql', import.meta.url),
    ),
    'utf8',
  );
  try {
    return parseTrialPolicyStatus(
      await runPsqlReadOnlyQuery(sql, { connection: connection(password) }),
    );
  } catch (error) {
    if (error instanceof TrialPolicyFailure) throw error;
    throw new TrialPolicyFailure('TRIAL_POLICY_QUERY_FAILED');
  }
}
export function assertTrialPolicyChangeAllowed(
  operation: Exclude<TrialPolicyOperation, 'check'>,
  status: TrialPolicyStatus,
): void {
  if (operation === 'stop') return;
  if (
    status.enabled ||
    !status.historyEmpty ||
    !status.policyTriggerPresent ||
    (operation === 'enable'
      ? !status.trialPrepared
      : !status.initialPolicy && !status.trialPrepared)
  )
    throw new TrialPolicyFailure('TRIAL_POLICY_STATE_INVALID');
}
const TRIAL_POLICY_SETTINGS_SENTINEL = '-- TRIAL_POLICY_SETTINGS\n';
export function buildTrialPolicySql(
  source: string,
  operation: Exclude<TrialPolicyOperation, 'check'>,
  providerCostVerified: boolean,
): string {
  if (
    !['prepare', 'enable', 'stop'].includes(operation) ||
    typeof providerCostVerified !== 'boolean' ||
    (operation === 'enable' && !providerCostVerified) ||
    !source.startsWith(`BEGIN READ WRITE;\n${TRIAL_POLICY_SETTINGS_SENTINEL}`) ||
    source.split(TRIAL_POLICY_SETTINGS_SENTINEL).length !== 2
  )
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  return source.replace(
    TRIAL_POLICY_SETTINGS_SENTINEL,
    [
      `SET LOCAL manga_nikki.trial_policy_operation='${operation}';`,
      `SET LOCAL manga_nikki.trial_provider_cost_verified='${providerCostVerified ? 'true' : 'false'}';`,
      '',
    ].join('\n'),
  );
}
export function classifyTrialPolicyWriteFailure(error: unknown): TrialPolicyWriteCause {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('stderr' in error) ||
    typeof error.stderr !== 'string' ||
    error.stderr.length > 32768
  )
    return 'UNKNOWN';
  const guards = new Set<TrialPolicyWriteCause>([
    'TRIAL_POLICY_CONTEXT_INVALID',
    'TRIAL_POLICY_STATE_INVALID',
    'TRIAL_POLICY_HISTORY_NOT_EMPTY',
    'TRIAL_PROFILE_INVALID',
    'TRIAL_PROVIDER_COST_NOT_VERIFIED',
  ]);
  const readOnlyMessages = new Set([
    'cannot execute UPDATE in a read-only transaction',
    'cannot execute SELECT FOR UPDATE in a read-only transaction',
    'cannot execute DO in a read-only transaction',
    'cannot set transaction read-write mode during recovery',
    'cannot set transaction read-write mode inside a read-only transaction',
  ]);
  const causes = new Set<TrialPolicyWriteCause>();
  for (const rawLine of error.stderr.split(/\r?\n/)) {
    const line = rawLine.replace(/^psql:[^\r\n]+:[0-9]+: /, '');
    const match = /^ERROR:[ \t]+(.+)$/.exec(line);
    if (!match) continue;
    const message = match[1]!;
    if (guards.has(message as TrialPolicyWriteCause)) causes.add(message as TrialPolicyWriteCause);
    else if (readOnlyMessages.has(message)) causes.add('READ_ONLY_TRANSACTION');
    else return 'UNKNOWN';
  }
  return causes.size === 1 ? [...causes][0]! : 'UNKNOWN';
}
export function renderTrialPolicyStatus(status: TrialPolicyStatus): string {
  return `enabled=${status.enabled} initialPolicy=${status.initialPolicy} trialPrepared=${status.trialPrepared} historyEmpty=${status.historyEmpty} policyTriggerPresent=${status.policyTriggerPresent}`;
}
export async function writeTrialPolicy(
  operation: Exclude<TrialPolicyOperation, 'check'>,
  password: string,
  providerCostVerified = false,
  executor: typeof execute = execute,
): Promise<void> {
  if (
    !['prepare', 'enable', 'stop'].includes(operation) ||
    typeof providerCostVerified !== 'boolean' ||
    (operation === 'enable' && !providerCostVerified)
  )
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  await verifyPinnedRootCertificate(DEV_DATABASE_ROOT_CERTIFICATE_PATH, new Date());
  const source = await readFile(TRIAL_POLICY_WRITE_PATH, 'utf8');
  const sql = buildTrialPolicySql(source, operation, providerCostVerified);
  const env = createPsqlEnvironment(connection(password));
  env.PGOPTIONS =
    '-c default_transaction_read_only=off -c statement_timeout=15000 -c lock_timeout=5000 -c search_path=pg_catalog';
  let directory: string | undefined;
  let failed = false;
  let writeCause: TrialPolicyWriteCause = 'UNKNOWN';
  try {
    directory = await mkdtemp(join(tmpdir(), 'manga-nikki-trial-policy-'));
    const sqlPath = join(directory, 'policy.sql');
    await writeFile(sqlPath, sql, { mode: 0o600, flag: 'wx' });
    const result = await executor(
      DEV_DATABASE_PSQL_PATH,
      ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', sqlPath],
      { env, timeout: 30000, maxBuffer: 32768, windowsHide: true },
    );
    if (String(result.stdout).trim() !== 'TRIAL_POLICY_TRANSACTION_COMMITTED') {
      failed = true;
      writeCause = 'COMMIT_MARKER_MISSING';
    }
  } catch (error) {
    failed = true;
    writeCause = classifyTrialPolicyWriteFailure(error);
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        failed = true;
        writeCause = 'TEMPORARY_FILE_CLEANUP_FAILED';
      }
    }
  }
  if (failed) throw new TrialPolicyFailure('TRIAL_POLICY_WRITE_RESULT_UNKNOWN', writeCause);
}
