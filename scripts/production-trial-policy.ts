import { appendFile } from 'node:fs/promises';
import { DevDatabasePreflightFailure } from '../src/build/dev-database-preflight.ts';
import {
  TrialPolicyFailure,
  gateTrialPolicy,
  readTrialPolicyStatus,
  assertTrialPolicyChangeAllowed,
  writeTrialPolicy,
  renderTrialPolicyStatus,
} from '../src/build/production-trial-policy.ts';

async function summary(content: string): Promise<void> {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, content, { mode: 0o600 });
}
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--gate-only'))
    throw new TrialPolicyFailure('TRIAL_POLICY_INPUT_INVALID');
  const operation = await gateTrialPolicy(process.env);
  if (args[0] !== '--gate-only') {
    const password = process.env.SUPABASE_DB_PASSWORD ?? '';
    let status = await readTrialPolicyStatus(password);
    console.log(`production-trial-policy: PRECHECK ${renderTrialPolicyStatus(status)}`);
    await summary(
      [
        '## 本番生成policy',
        '',
        `- Operation: ${operation}`,
        `- Existing enabled: ${status.enabled}`,
        `- Fixed trial limits/profile: ${status.trialPrepared}`,
        `- Public 80 USD policy active: ${status.public80Active}`,
        `- Event 250 policy prepared: ${status.event250Prepared}`,
        `- Generation history empty: ${status.historyEmpty}`,
        `- Policy update trigger intact: ${status.policyTriggerPresent}`,
        '',
      ].join('\n'),
    );
    let write = 'not-attempted';
    if (operation !== 'check') {
      assertTrialPolicyChangeAllowed(operation, status);
      await gateTrialPolicy(process.env);
      await summary(
        '- Policy write attempted: yes\n- 書込開始後の中断・失敗は結果不明としてread-only checkで調査し、自動再実行しません。\n',
      );
      await writeTrialPolicy(
        operation,
        password,
        process.env.PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED === 'true',
      );
      write = 'transaction-committed';
      status = await readTrialPolicyStatus(password);
      console.log(`production-trial-policy: POSTCHECK ${renderTrialPolicyStatus(status)}`);
      if (
        operation === 'stop'
          ? status.enabled
          : operation === 'activate-public80'
            ? !status.enabled || !status.public80Prepared
            : operation === 'activate-event250'
              ? !status.enabled || !status.event250Prepared
              : !status.trialPrepared || status.enabled !== (operation === 'enable')
      )
        throw new TrialPolicyFailure('TRIAL_POLICY_WRITE_RESULT_UNKNOWN');
    }
    await summary(
      [
        `- Policy write: ${write}`,
        `- Confirmed enabled: ${status.enabled}`,
        '- 固定試験枠（prepare/enableの設定値）: owner/JST日・全体/JST日・全期間の各上限1漫画、総予算1,000,000 micro USD（1USD）。',
        '- 固定既存OpenAI profileのmax_cost_micro_usd=1,000,000はDB予約額です。providerが実請求を1USD以内に制限する厳密なcapではありません。',
        '- activate-public80は累積予約budget 80,000,000 micro USD、通常owner/JST日3回、全体件数capなし、初回成功ownerの日次回数例外です。既存予約・デバッグ費用も累積budgetに含みます。',
        '- activate-event250は稼働中の固定public80 policyからの一回限り移行です。既存利用を含む全期間250件、内部予約budget 250,000,000 micro USD、通常owner/JST日3回を設定し、既存予約・counter・履歴・owner例外を保持します。停止後の再適用はできません。',
        '- enable、activate-public80、activate-event250は費用検証済みの明示確認が必要です。内部予約budgetはprovider実請求の厳密なcapではありません。prepareは停止を維持します。',
        '- このworkflowはAI APIを呼ばず、counter・reservation・既存generation・履歴を変更しません。stopも既存予約やunknownの枠を解放しません。',
        '',
      ].join('\n'),
    );
    console.log('production-trial-policy: TRIAL_POLICY_CHECK_FINISHED');
  }
} catch (error) {
  const code =
    error instanceof TrialPolicyFailure || error instanceof DevDatabasePreflightFailure
      ? error.code
      : 'INTERNAL_ERROR';
  console.error(`production-trial-policy: ${code}`);
  if (error instanceof TrialPolicyFailure && error.writeCause) {
    console.error(`production-trial-policy: WRITE_FAILURE_CAUSE=${error.writeCause}`);
    await summary(`- Write failure cause: \`${error.writeCause}\`\n`).catch(() => undefined);
  }
  await summary(`- Result code: \`${code}\`\n`).catch(() => undefined);
  process.exitCode = 1;
}
