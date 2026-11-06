import { appendFile } from 'node:fs/promises';
import {
  DevDatabasePreflightFailure,
  renderDevDatabasePreflightSummary,
  runDevDatabasePreflight,
  runDevDatabasePreflightGate,
  type DevDatabasePreflightContext,
} from '../src/build/dev-database-preflight.ts';

type DisplayErrorCode =
  | DevDatabasePreflightFailure['code']
  | 'INPUT_ARGUMENT_INVALID'
  | 'INTERNAL_ERROR'
  | 'SUMMARY_WRITE_FAILED';

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

function errorCode(error: unknown): DisplayErrorCode {
  return error instanceof DevDatabasePreflightFailure ? error.code : 'INTERNAL_ERROR';
}

function renderFailureSummary(code: DisplayErrorCode): string {
  return [
    '## 開発Supabase DB読み取り確認',
    '',
    '- 確認結果: 失敗',
    `- Failure code: \`${code}\``,
    '- エラー詳細、接続文字列、秘密情報は出力していません。',
    '',
  ].join('\n');
}

async function writeSummary(path: string, content: string): Promise<void> {
  await appendFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--gate-only')) {
    console.error('dev-database-preflight: INPUT_ARGUMENT_INVALID');
    process.exitCode = 1;
    return;
  }

  const context = contextFromEnvironment(process.env);
  if (args[0] === '--gate-only') {
    try {
      await runDevDatabasePreflightGate(context);
      console.log('dev-database-preflight: PREFLIGHT_GATE_CONFIRMED');
    } catch (error) {
      console.error(`dev-database-preflight: ${errorCode(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  let summary = '';
  let failureCode: DisplayErrorCode | undefined;
  try {
    const result = await runDevDatabasePreflight(context);
    summary = renderDevDatabasePreflightSummary(result);
  } catch (error) {
    failureCode = errorCode(error);
    summary = renderFailureSummary(failureCode);
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
    console.error(`dev-database-preflight: ${failureCode}`);
    process.exitCode = 1;
  }
  if (summaryWriteFailed) {
    console.error('dev-database-preflight: SUMMARY_WRITE_FAILED');
    process.exitCode = 1;
  }
}

await main();
