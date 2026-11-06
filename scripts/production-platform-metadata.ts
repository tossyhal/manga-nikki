import { appendFile } from 'node:fs/promises';
import {
  runDevDatabasePreflightGate,
  DevDatabasePreflightFailure,
} from '../src/build/dev-database-preflight.ts';
import {
  ProductionPlatformMetadataFailure,
  readProductionPlatformMetadata,
  validateStoragePolicyOperation,
  assertStoragePolicySetupAllowed,
} from '../src/build/production-platform-metadata.ts';
import { applyProductionStoragePolicies } from '../src/build/production-platform-policy-runner.ts';
async function main(): Promise<void> {
  try {
    if (
      process.argv.slice(2).some((arg) => arg !== '--gate-only') ||
      process.argv.length > 3 ||
      process.env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID !== '6d238b9e-fdaf-497a-afef-b4f9011f9d33'
    )
      throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
    const apply = validateStoragePolicyOperation(process.env);
    const context = {
      githubActions: process.env.GITHUB_ACTIONS,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubSha: process.env.GITHUB_SHA,
      githubActorId: process.env.GITHUB_ACTOR_ID,
      githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
      githubToken: process.env.GITHUB_TOKEN,
      bwsSecretId: process.env.BWS_SUPABASE_DB_PASSWORD_SECRET_ID,
    };
    await runDevDatabasePreflightGate(context);
    if (process.argv[2] === '--gate-only') return;
    let result = await readProductionPlatformMetadata(process.env.SUPABASE_DB_PASSWORD ?? '');
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## Storage policy preflight',
          '',
          `- Missing policies: ${result.missingPolicyCount}`,
          `- Mismatched policies: ${result.mismatchedPolicyCount}`,
          `- Table owners identical: ${result.sameStorageOwner ? 'yes' : 'no'}`,
          `- Inherited owner privilege: ${result.ownerPrivilege ? 'yes' : 'no'}`,
          `- SET ROLE privilege: ${result.ownerSetPrivilege ? 'yes' : 'no'}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
    let policyWrite = 'not-attempted';
    if (apply) {
      assertStoragePolicySetupAllowed(result);
      if (!result.policiesOk) {
        await runDevDatabasePreflightGate(context);
        if (process.env.GITHUB_STEP_SUMMARY)
          await appendFile(
            process.env.GITHUB_STEP_SUMMARY,
            '## Storage policy setup\n\n- Policy write attempted: yes\n- 中断・失敗時は結果をread-onlyで調査し、自動再実行しません。\n\n',
            { mode: 0o600 },
          );
        await applyProductionStoragePolicies(process.env.SUPABASE_DB_PASSWORD ?? '');
        policyWrite = 'transaction-committed';
        result = await readProductionPlatformMetadata(process.env.SUPABASE_DB_PASSWORD ?? '');
        if (!result.policiesOk)
          throw new ProductionPlatformMetadataFailure('STORAGE_POLICY_WRITE_RESULT_UNKNOWN');
      } else {
        policyWrite = 'noop';
      }
    }
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
          `- Missing policies: ${result.missingPolicyCount}`,
          `- Mismatched policies: ${result.mismatchedPolicyCount}`,
          `- Table owners identical: ${result.sameStorageOwner ? 'yes' : 'no'}`,
          `- Policy write: ${policyWrite}`,
          '- bucket内部レコード・RLS設定・GRANT・migration履歴は変更していません。',
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
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `- Result code: \`${code}\`\n- owner権限がなければ[SQL Editor](https://supabase.com/dashboard/project/leihsygtsamxffyybskh/sql/new)でtable ownerを選べるか確認し、review済みsupabase/operations/production-platform-policies.sqlだけを実行します。roleが選べなければプラットフォーム管理者へ引き継ぎ、追加GRANTでは回避しません。\n`,
        { mode: 0o600 },
      ).catch(() => undefined);
    }
    process.exitCode = 1;
  }
}
await main();
