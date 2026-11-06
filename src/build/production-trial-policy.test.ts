import { describe, expect, it, vi } from 'vitest';
import {
  validateTrialPolicyInput,
  assertTrialPolicyChangeAllowed,
  parseTrialPolicyStatus,
  writeTrialPolicy,
  TRIAL_POLICY_CONFIRMATIONS,
  TRIAL_POLICY_WRITE_PATH,
} from './production-trial-policy.ts';
const databaseReference = '6d238b9e-fdaf-497a-afef-b4f9011f9d33';
const env = {
  BWS_SUPABASE_DB_PASSWORD_SECRET_ID: databaseReference,
  GITHUB_RUN_ATTEMPT: '1',
};
const status = {
  enabled: false,
  initialPolicy: true,
  trialPrepared: false,
  historyEmpty: true,
  policyTriggerPresent: true,
};
describe('初回試験policy入力', () => {
  it('checkは確認文字列なしでread-onlyを選ぶ', () =>
    expect(validateTrialPolicyInput({ ...env, PRODUCTION_TRIAL_POLICY_OPERATION: 'check' })).toBe(
      'check',
    ));
  it.each(['prepare', 'enable', 'stop'] as const)(
    'writeは初回と固定確認を要求する %s',
    (operation) => {
      const input = {
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: operation,
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: TRIAL_POLICY_CONFIRMATIONS[operation],
        PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED: 'true',
      };
      expect(validateTrialPolicyInput(input)).toBe(operation);
      expect(() => validateTrialPolicyInput({ ...input, GITHUB_RUN_ATTEMPT: '2' })).toThrow(
        'TRIAL_POLICY_INPUT_INVALID',
      );
      expect(() =>
        validateTrialPolicyInput({ ...input, PRODUCTION_TRIAL_POLICY_CONFIRMATION: 'yes' }),
      ).toThrow('TRIAL_POLICY_INPUT_INVALID');
    },
  );
  it('enableはprovider費用検証済みflagを要求する', () => {
    expect(() =>
      validateTrialPolicyInput({
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: 'enable',
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: TRIAL_POLICY_CONFIRMATIONS.enable,
      }),
    ).toThrow('TRIAL_POLICY_INPUT_INVALID');
  });
});
describe('policy状態', () => {
  it('initial停止状態からprepareだけ許可する', () => {
    expect(() => assertTrialPolicyChangeAllowed('prepare', status)).not.toThrow();
    expect(() => assertTrialPolicyChangeAllowed('enable', status)).toThrow(
      'TRIAL_POLICY_STATE_INVALID',
    );
  });
  it('prepare済みでも履歴があればenable/prepareを止める', () => {
    for (const operation of ['prepare', 'enable'] as const)
      expect(() =>
        assertTrialPolicyChangeAllowed(operation, {
          ...status,
          trialPrepared: true,
          initialPolicy: false,
          historyEmpty: false,
        }),
      ).toThrow('TRIAL_POLICY_STATE_INVALID');
  });
  it('stopは既存履歴や実行中状態があっても許可する', () => {
    expect(() =>
      assertTrialPolicyChangeAllowed('stop', {
        ...status,
        enabled: true,
        historyEmpty: false,
        policyTriggerPresent: false,
      }),
    ).not.toThrow();
  });
  it('固定profile準備済みの停止状態からenableを許可する', () => {
    expect(() =>
      assertTrialPolicyChangeAllowed('enable', {
        ...status,
        trialPrepared: true,
        initialPolicy: false,
      }),
    ).not.toThrow();
  });
  it('metadataのidentity/read-onlyと型を検証する', () => {
    const data = { ...status, identityOk: true, readOnly: true, policyExists: true };
    expect(parseTrialPolicyStatus(JSON.stringify(data))).toEqual(status);
    expect(() => parseTrialPolicyStatus(JSON.stringify({ ...data, readOnly: false }))).toThrow(
      'TRIAL_POLICY_METADATA_INVALID',
    );
    expect(() => parseTrialPolicyStatus(JSON.stringify({ ...data, enabled: null }))).toThrow(
      'TRIAL_POLICY_METADATA_INVALID',
    );
  });
});
describe('固定SQL write runner', () => {
  it('固定ファイル、固定operationとminimal TLS環境だけで一度実行する', async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ stdout: 'TRIAL_POLICY_TRANSACTION_COMMITTED\n', stderr: '' });
    await writeTrialPolicy('prepare', 'fixture-password', false, executor);
    const [file, args, options] = executor.mock.calls[0]!;
    expect(file).toBe('/usr/lib/postgresql/16/bin/psql');
    expect(args).toEqual([
      '-X',
      '--no-password',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      TRIAL_POLICY_WRITE_PATH,
    ]);
    expect(options.env).toMatchObject({
      PGSSLMODE: 'verify-full',
      PGPASSWORD: 'fixture-password',
      PGHOST: 'aws-0-ap-northeast-1.pooler.supabase.com',
      PGUSER: 'postgres.leihsygtsamxffyybskh',
    });
    expect(Object.keys(options.env).sort()).toEqual(
      [
        'PATH',
        'LANG',
        'PGHOST',
        'PGPORT',
        'PGDATABASE',
        'PGUSER',
        'PGPASSWORD',
        'PGSSLMODE',
        'PGSSLROOTCERT',
        'PGCONNECT_TIMEOUT',
        'PGOPTIONS',
        'PGAPPNAME',
      ].sort(),
    );
    expect(options.env.PGOPTIONS).toContain('manga_nikki.trial_policy_operation=prepare');
    expect(executor).toHaveBeenCalledTimes(1);
  });
  it('費用未検証enableはprocessを起動しない', async () => {
    const executor = vi.fn();
    await expect(writeTrialPolicy('enable', 'fixture-password', false, executor)).rejects.toThrow(
      'TRIAL_POLICY_INPUT_INVALID',
    );
    expect(executor).not.toHaveBeenCalled();
  });
  it('SQLerrorやCOMMIT marker欠損を生出力せず不明状態にする', async () => {
    for (const executor of [
      vi.fn().mockRejectedValue(new Error('private-error')),
      vi.fn().mockResolvedValue({ stdout: '', stderr: 'private-error' }),
    ]) {
      await expect(
        writeTrialPolicy('prepare', 'fixture-password', false, executor),
      ).rejects.toThrow('TRIAL_POLICY_WRITE_RESULT_UNKNOWN');
      expect(executor).toHaveBeenCalledTimes(1);
    }
  });
});
