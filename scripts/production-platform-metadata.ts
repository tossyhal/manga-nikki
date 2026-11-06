import { appendFile } from 'node:fs/promises';
import {
  runDevDatabasePreflightGate,
  DevDatabasePreflightFailure,
} from '../src/build/dev-database-preflight.ts';
import {
  ProductionPlatformMetadataFailure,
  readProductionPlatformMetadata,
} from '../src/build/production-platform-metadata.ts';
async function main(): Promise<void> {
  try {
    if (
      process.argv.slice(2).some((arg) => arg !== '--gate-only') ||
      process.argv.length > 3 ||
      process.env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID !== '6d238b9e-fdaf-497a-afef-b4f9011f9d33'
    )
      throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
    await runDevDatabasePreflightGate({
      githubActions: process.env.GITHUB_ACTIONS,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubSha: process.env.GITHUB_SHA,
      githubActorId: process.env.GITHUB_ACTOR_ID,
      githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
      githubToken: process.env.GITHUB_TOKEN,
      bwsSecretId: process.env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID,
    });
    if (process.argv[2] === '--gate-only') return;
    const result = await readProductionPlatformMetadata(process.env.SUPABASE_DB_PASSWORD ?? '');
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## Storage read-only metadata',
          '',
          '- Identity/read-only/RLS/grants: passed',
          `- Connected postgres inherits table owner privileges: ${result.ownerPrivilege ? 'yes' : 'no'}`,
          `- Connected postgres can SET ROLE to table owner: ${result.ownerSetPrivilege ? 'yes' : 'no'}`,
          `- Comics restrictive policies: ${result.policiesOk ? 'present-and-matched' : 'missing-or-mismatched'}`,
          '- DDLとbucket内部レコードの変更は実行していません。',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
    if (!result.policiesOk)
      throw new ProductionPlatformMetadataFailure('STORAGE_POLICY_SETUP_REQUIRED');
    console.log('production-platform-metadata: STORAGE_METADATA_PASSED');
  } catch (error) {
    const code =
      error instanceof ProductionPlatformMetadataFailure ||
      error instanceof DevDatabasePreflightFailure
        ? error.code
        : 'INTERNAL_ERROR';
    console.error(`production-platform-metadata: ${code}`);
    process.exitCode = 1;
  }
}
await main();
