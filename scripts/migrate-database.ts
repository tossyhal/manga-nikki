import { appendFile } from 'node:fs/promises';
import {
  DatabaseMigrationFailure,
  renderDatabaseMigrationSummary,
  runDatabaseMigration,
  runDatabaseMigrationGate,
  type DatabaseMigrationInput,
  type DatabaseMigrationOperation,
  type PinnedCliConfiguration,
} from '../src/build/database-migration.ts';
import {
  DevDatabasePreflightFailure,
  type DevDatabasePreflightContext,
} from '../src/build/dev-database-preflight.ts';
import { SupabaseCliFailure } from '../src/build/database-migration-runner.ts';

type DisplayErrorCode =
  | DatabaseMigrationFailure['code']
  | DevDatabasePreflightFailure['code']
  | SupabaseCliFailure['code']
  | 'INPUT_ARGUMENT_INVALID'
  | 'INTERNAL_ERROR'
  | 'SUMMARY_WRITE_FAILED';

function inputFromEnvironment(environment: NodeJS.ProcessEnv): DatabaseMigrationInput {
  return {
    operation: environment.DATABASE_MIGRATION_OPERATION,
    expectedManifest: environment.DATABASE_MIGRATION_EXPECTED_MANIFEST,
  };
}

function contextFromEnvironment(environment: NodeJS.ProcessEnv): DevDatabasePreflightContext {
  return {
    githubActions: environment.GITHUB_ACTIONS,
    githubRepository: environment.GITHUB_REPOSITORY,
    githubRef: environment.GITHUB_REF,
    githubEventName: environment.GITHUB_EVENT_NAME,
    githubSha: environment.GITHUB_SHA,
    githubActorId: environment.GITHUB_ACTOR_ID,
    githubTriggeringActor: environment.GITHUB_TRIGGERING_ACTOR,
    githubToken: environment.GITHUB_TOKEN,
    bwsSecretId: environment.BWS_SUPABASE_DB_PASSWORD_SECRET_ID,
    databasePassword: environment.SUPABASE_DB_PASSWORD,
  };
}

function cliFromEnvironment(environment: NodeJS.ProcessEnv): PinnedCliConfiguration {
  return {
    runnerTemporaryDirectory: environment.RUNNER_TEMP ?? '',
    cliPath: environment.SUPABASE_CLI_PATH ?? '',
    cliSha256: environment.SUPABASE_CLI_SHA256 ?? '',
    sidecarPath: environment.SUPABASE_GO_PATH ?? '',
    sidecarSha256: environment.SUPABASE_GO_SHA256 ?? '',
  };
}

function errorCode(error: unknown): DisplayErrorCode {
  if (
    error instanceof DatabaseMigrationFailure ||
    error instanceof DevDatabasePreflightFailure ||
    error instanceof SupabaseCliFailure
  ) {
    return error.code;
  }
  return 'INTERNAL_ERROR';
}

function operationFromEnvironment(environment: NodeJS.ProcessEnv): DatabaseMigrationOperation {
  return environment.DATABASE_MIGRATION_OPERATION === 'apply' ? 'apply' : 'plan';
}

function renderFailureSummary(
  code: DisplayErrorCode,
  operation: DatabaseMigrationOperation,
): string {
  return [
    '## Supabase DB migration',
    '',
    `- Operation: \`${operation}\``,
    '- Outcome: `failed`',
    `- Failure code: \`${code}\``,
    '- エラー詳細、SQL本文、DB出力、接続情報、秘密情報は記録していません。',
    '',
  ].join('\n');
}

async function writeSummary(path: string, content: string): Promise<void> {
  await appendFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--gate-only')) {
    console.error('database-migration: INPUT_ARGUMENT_INVALID');
    process.exitCode = 1;
    return;
  }

  const input = inputFromEnvironment(process.env);
  const context = contextFromEnvironment(process.env);
  if (args[0] === '--gate-only') {
    try {
      await runDatabaseMigrationGate(input, context);
      console.log('database-migration: PREFLIGHT_GATE_CONFIRMED');
    } catch (error) {
      console.error(`database-migration: ${errorCode(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  let summary = '';
  let failureCode: DisplayErrorCode | undefined;
  try {
    const result = await runDatabaseMigration(input, context, {
      cli: cliFromEnvironment(process.env),
    });
    summary = renderDatabaseMigrationSummary(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    failureCode = errorCode(error);
    summary = renderFailureSummary(failureCode, operationFromEnvironment(process.env));
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  let summaryWriteFailed = false;
  if (summaryPath) {
    try {
      await writeSummary(summaryPath, summary);
    } catch {
      summaryWriteFailed = true;
    }
  }

  if (failureCode) {
    console.error(`database-migration: ${failureCode}`);
    process.exitCode = 1;
  }
  if (summaryWriteFailed) {
    console.error('database-migration: SUMMARY_WRITE_FAILED');
    process.exitCode = 1;
  }
}

await main();
