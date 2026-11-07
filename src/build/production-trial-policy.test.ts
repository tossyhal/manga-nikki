import { describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  validateTrialPolicyInput,
  assertTrialPolicyChangeAllowed,
  parseTrialPolicyStatus,
  writeTrialPolicy,
  TRIAL_POLICY_CONFIRMATIONS,
  buildTrialPolicySql,
  classifyTrialPolicyWriteFailure,
  renderTrialPolicyStatus,
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
  public80SchemaReady: false,
  public80Ready: false,
  public80Prepared: false,
  public80Active: false,
  event250Prepared: false,
  event1000Prepared: false,
  activeGenerationCount: 0,
  cumulativeReservedCount: 0,
  cumulativeReservedMicroUsd: 0,
};
describe('初回試験policy入力', () => {
  it('checkは確認文字列なしでread-onlyを選ぶ', () =>
    expect(validateTrialPolicyInput({ ...env, PRODUCTION_TRIAL_POLICY_OPERATION: 'check' })).toBe(
      'check',
    ));
  it.each([
    'prepare',
    'enable',
    'stop',
    'activate-public80',
    'activate-event250',
    'activate-event1000',
  ] as const)('writeは初回と固定確認を要求する %s', (operation) => {
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
  });
  it('enableはprovider費用検証済みflagを要求する', () => {
    expect(() =>
      validateTrialPolicyInput({
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: 'enable',
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: TRIAL_POLICY_CONFIRMATIONS.enable,
      }),
    ).toThrow('TRIAL_POLICY_INPUT_INVALID');
  });
  it('activate-event250は固定確認だけでなく費用検証済みflagを要求する', () => {
    expect(() =>
      validateTrialPolicyInput({
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: 'activate-event250',
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: TRIAL_POLICY_CONFIRMATIONS['activate-event250'],
      }),
    ).toThrow('TRIAL_POLICY_INPUT_INVALID');
  });
  it('activate-event1000は日本語の固定確認と費用検証済みflagを要求する', () => {
    const confirmation = TRIAL_POLICY_CONFIRMATIONS['activate-event1000'];
    expect(confirmation).toBe(
      'event250稼働中から本番全期間1000件・内部予約1000USD相当へ一度だけ変更（JST日3回）',
    );
    expect(
      validateTrialPolicyInput({
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: 'activate-event1000',
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: confirmation,
        PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED: 'true',
      }),
    ).toBe('activate-event1000');
    for (const changes of [
      { PRODUCTION_TRIAL_POLICY_CONFIRMATION: 'yes' },
      { PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED: 'false' },
    ])
      expect(() =>
        validateTrialPolicyInput({
          ...env,
          PRODUCTION_TRIAL_POLICY_OPERATION: 'activate-event1000',
          PRODUCTION_TRIAL_POLICY_CONFIRMATION: confirmation,
          PRODUCTION_TRIAL_PROVIDER_COST_VERIFIED: 'true',
          ...changes,
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
    expect(() =>
      parseTrialPolicyStatus(JSON.stringify({ ...data, activeGenerationCount: -1 })),
    ).toThrow('TRIAL_POLICY_METADATA_INVALID');
  });
});
describe('固定SQL write runner', () => {
  it('標準PGOPTIONSと同transaction内設定を渡し、0600一時SQLを完了後に削除する', async () => {
    let sqlPath = '';
    const executor = vi.fn().mockImplementation(async (_file, args, options) => {
      sqlPath = args[args.length - 1];
      expect((await stat(sqlPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(sqlPath))).mode & 0o777).toBe(0o700);
      const sql = await readFile(sqlPath, 'utf8');
      expect(sql).toMatch(
        /^BEGIN READ WRITE;\nSET LOCAL manga_nikki.trial_policy_operation='prepare';\nSET LOCAL manga_nikki.trial_provider_cost_verified='false';\n/,
      );
      expect(sql).not.toContain('fixture-password');
      expect(options.env.PGOPTIONS).toBe(
        '-c default_transaction_read_only=off -c statement_timeout=15000 -c lock_timeout=5000 -c search_path=pg_catalog',
      );
      return { stdout: 'TRIAL_POLICY_TRANSACTION_COMMITTED\n', stderr: '' };
    });
    await writeTrialPolicy('prepare', 'fixture-password', false, executor);
    const [file, args, options] = executor.mock.calls[0]!;
    expect(file).toBe('/usr/lib/postgresql/16/bin/psql');
    expect(args).toEqual(['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', sqlPath]);
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
    await expect(stat(sqlPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(dirname(sqlPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(executor).toHaveBeenCalledTimes(1);
  });
  it('SQLerror時も一時SQLを削除し、unknownを維持して既知causeだけ返す', async () => {
    let sqlPath = '';
    const executor = vi.fn().mockImplementation(async (_file, args) => {
      sqlPath = args[args.length - 1];
      throw {
        stderr:
          'psql:/tmp/fixture.sql:33: ERROR:  TRIAL_POLICY_CONTEXT_INVALID\nCONTEXT: private fixture detail\n',
      };
    });
    await expect(
      writeTrialPolicy('prepare', 'fixture-password', false, executor),
    ).rejects.toMatchObject({
      code: 'TRIAL_POLICY_WRITE_RESULT_UNKNOWN',
      writeCause: 'TRIAL_POLICY_CONTEXT_INVALID',
    });
    await expect(stat(sqlPath)).rejects.toMatchObject({ code: 'ENOENT' });
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

describe('transaction内の固定SQL設定', () => {
  const source = 'BEGIN READ WRITE;\n-- TRIAL_POLICY_SETTINGS\nSELECT 1;\nCOMMIT;\n';
  it.each([
    'prepare',
    'enable',
    'stop',
    'activate-public80',
    'activate-event250',
    'activate-event1000',
  ] as const)('allowlist済みoperationだけ固定literalで挿入する %s', (operation) => {
    const sql = buildTrialPolicySql(
      source,
      operation,
      operation === 'enable' ||
        operation === 'activate-public80' ||
        operation === 'activate-event250' ||
        operation === 'activate-event1000',
    );
    expect(sql).toContain(`SET LOCAL manga_nikki.trial_policy_operation='${operation}';`);
    expect(sql).not.toContain('-- TRIAL_POLICY_SETTINGS');
  });
  it.each([
    'BEGIN;\n-- TRIAL_POLICY_SETTINGS\n',
    source + '-- TRIAL_POLICY_SETTINGS\n',
    source.replace('-- TRIAL_POLICY_SETTINGS', '-- changed'),
  ])('sentinelの位置/重複/欠落を拒否する', (invalid) => {
    expect(() => buildTrialPolicySql(invalid, 'prepare', false)).toThrow(
      'TRIAL_POLICY_INPUT_INVALID',
    );
  });
  it('operationや費用flagを任意SQL文字列として扱わない', () => {
    expect(() => buildTrialPolicySql(source, "prepare'; SELECT 1;--" as 'prepare', false)).toThrow(
      'TRIAL_POLICY_INPUT_INVALID',
    );
    expect(() => buildTrialPolicySql(source, 'prepare', 'false' as unknown as boolean)).toThrow(
      'TRIAL_POLICY_INPUT_INVALID',
    );
  });
  it('状態のstdoutは固定booleanだけから作る', () => {
    expect(renderTrialPolicyStatus(status)).toBe(
      'enabled=false initialPolicy=true trialPrepared=false historyEmpty=true policyTriggerPresent=true public80SchemaReady=false public80Ready=false public80Prepared=false public80Active=false event250Prepared=false event1000Prepared=false activeGenerationCount=0 cumulativeReservedCount=0 cumulativeReservedMicroUsd=0',
    );
  });
});
describe('write失敗の安全な分類', () => {
  it.each([
    'TRIAL_POLICY_CONTEXT_INVALID',
    'TRIAL_POLICY_STATE_INVALID',
    'TRIAL_POLICY_HISTORY_NOT_EMPTY',
    'TRIAL_PROFILE_INVALID',
    'TRIAL_PROVIDER_COST_NOT_VERIFIED',
  ])('完全一致する既知guardだけ分類する %s', (guard) => {
    expect(
      classifyTrialPolicyWriteFailure({
        stderr: `psql:/tmp/fixture.sql:12: ERROR:  ${guard}\nCONTEXT: private fixture detail\n`,
      }),
    ).toBe(guard);
    expect(classifyTrialPolicyWriteFailure({ stderr: `ERROR:  ${guard} private-extra` })).toBe(
      'UNKNOWN',
    );
  });
  it('標準read-onlyエラーだけ固定分類し、生errorや複数原因を返さない', () => {
    expect(
      classifyTrialPolicyWriteFailure({
        stderr: 'ERROR:  cannot execute UPDATE in a read-only transaction\n',
      }),
    ).toBe('READ_ONLY_TRANSACTION');
    expect(classifyTrialPolicyWriteFailure({ stderr: 'ERROR:  private fixture detail\n' })).toBe(
      'UNKNOWN',
    );
    expect(
      classifyTrialPolicyWriteFailure({
        stderr: 'ERROR:  TRIAL_POLICY_CONTEXT_INVALID\nERROR:  TRIAL_POLICY_STATE_INVALID\n',
      }),
    ).toBe('UNKNOWN');
  });
});

describe('発表用event250への一回限り移行', () => {
  const ready = {
    ...status,
    enabled: true,
    historyEmpty: false,
    public80SchemaReady: true,
    public80Active: true,
  };

  it('稼働中の固定public80からのみ移行を許可する', () => {
    expect(() => assertTrialPolicyChangeAllowed('activate-event250', ready)).not.toThrow();
    for (const changes of [
      { enabled: false },
      { public80SchemaReady: false },
      { public80Active: false },
      { policyTriggerPresent: false },
      { event250Prepared: true },
    ])
      expect(() =>
        assertTrialPolicyChangeAllowed('activate-event250', { ...ready, ...changes }),
      ).toThrow('TRIAL_POLICY_STATE_INVALID');
  });

  it('専用固定SQLだけを選び、履歴を書き換えない', async () => {
    const executor = vi.fn().mockImplementation(async (_file, args) => {
      const source = await readFile(args[args.length - 1], 'utf8');
      expect(source).toContain("trial_policy_operation='activate-event250'");
      expect(source).toContain('global_total_limit=250,budget_micro_usd=250000000');
      expect(source).not.toMatch(
        /(?:UPDATE|DELETE FROM|INSERT INTO) (?:public\.generations|private\.(?:reservations|quota_counters|provider_attempts))/i,
      );
      return { stdout: 'TRIAL_POLICY_TRANSACTION_COMMITTED', stderr: '' };
    });
    await writeTrialPolicy('activate-event250', 'fixture-password', true, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    await expect(
      writeTrialPolicy('activate-event250', 'fixture-password', false, executor),
    ).rejects.toThrow('TRIAL_POLICY_INPUT_INVALID');
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

describe('event250からevent1000への一回限り移行', () => {
  const ready = {
    ...status,
    enabled: true,
    historyEmpty: false,
    public80SchemaReady: true,
    event250Prepared: true,
  };

  it('稼働中の正確なevent250 policyからだけ移行を許可する', () => {
    expect(() => assertTrialPolicyChangeAllowed('activate-event1000', ready)).not.toThrow();
    for (const changes of [
      { enabled: false },
      { public80SchemaReady: false },
      { event250Prepared: false },
      { event1000Prepared: true },
      { policyTriggerPresent: false },
    ])
      expect(() =>
        assertTrialPolicyChangeAllowed('activate-event1000', { ...ready, ...changes }),
      ).toThrow('TRIAL_POLICY_STATE_INVALID');
    expect(() => assertTrialPolicyChangeAllowed('activate-event1000', status)).toThrow(
      'TRIAL_POLICY_STATE_INVALID',
    );
  });

  it('専用固定SQLだけを選び、各台帳を更新しない', async () => {
    const executor = vi.fn().mockImplementation(async (_file, args) => {
      const source = await readFile(args[args.length - 1], 'utf8');
      expect(source).toContain("trial_policy_operation='activate-event1000'");
      expect(source).toContain('global_total_limit=1000,budget_micro_usd=1000000000');
      expect(source).not.toMatch(
        /(?:UPDATE|DELETE FROM|INSERT INTO) (?:public\.generations|private\.(?:reservations|quota_counters|provider_attempts))/i,
      );
      return { stdout: 'TRIAL_POLICY_TRANSACTION_COMMITTED', stderr: '' };
    });
    await writeTrialPolicy('activate-event1000', 'fixture-password', true, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    await expect(
      writeTrialPolicy('activate-event1000', 'fixture-password', false, executor),
    ).rejects.toThrow('TRIAL_POLICY_INPUT_INVALID');
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

describe('累積80USD固定有効化', () => {
  it('新schemaと整合した成功試験以外からは有効化しない', () => {
    const ready = {
      ...status,
      historyEmpty: false,
      public80SchemaReady: true,
      public80Ready: true,
    };
    expect(() => assertTrialPolicyChangeAllowed('activate-public80', ready)).not.toThrow();
    for (const field of ['public80SchemaReady', 'public80Ready', 'policyTriggerPresent'] as const)
      expect(() =>
        assertTrialPolicyChangeAllowed('activate-public80', { ...ready, [field]: false }),
      ).toThrow('TRIAL_POLICY_STATE_INVALID');
    expect(() =>
      assertTrialPolicyChangeAllowed('activate-public80', { ...ready, enabled: true }),
    ).toThrow('TRIAL_POLICY_STATE_INVALID');
    expect(() => assertTrialPolicyChangeAllowed('enable', ready)).toThrow(
      'TRIAL_POLICY_STATE_INVALID',
    );
  });
  it('固定確認だけでは足りず費用承認も必要', () => {
    expect(() =>
      validateTrialPolicyInput({
        ...env,
        PRODUCTION_TRIAL_POLICY_OPERATION: 'activate-public80',
        PRODUCTION_TRIAL_POLICY_CONFIRMATION: TRIAL_POLICY_CONFIRMATIONS['activate-public80'],
      }),
    ).toThrow('TRIAL_POLICY_INPUT_INVALID');
  });
  it('新操作は専用固定SQLを選び既存履歴を更新しない', async () => {
    const executor = vi.fn().mockImplementation(async (_file, args) => {
      const source = await readFile(args[args.length - 1], 'utf8');
      expect(source).toContain("trial_policy_operation='activate-public80'");
      expect(source).toContain('budget_micro_usd=80000000');
      expect(source).toContain('daily_limit_exempt_owners=ARRAY[trial_owner]');
      expect(source).not.toMatch(
        /(?:UPDATE|DELETE FROM|INSERT INTO) (?:public.generations|private.reservations|private.quota_counters)/i,
      );
      return { stdout: 'TRIAL_POLICY_TRANSACTION_COMMITTED', stderr: '' };
    });
    await writeTrialPolicy('activate-public80', 'fixture-password', true, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    await expect(
      writeTrialPolicy('activate-public80', 'fixture-password', false, executor),
    ).rejects.toThrow('TRIAL_POLICY_INPUT_INVALID');
  });
  it('不正な累積額をmetadataとして出力しない', () => {
    const data = { ...status, identityOk: true, readOnly: true, policyExists: true };
    for (const amount of [-1, '1000000', null, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        parseTrialPolicyStatus(JSON.stringify({ ...data, cumulativeReservedMicroUsd: amount })),
      ).toThrow('TRIAL_POLICY_METADATA_INVALID');
  });
});
