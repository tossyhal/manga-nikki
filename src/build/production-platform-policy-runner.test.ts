import { describe, expect, it, vi } from 'vitest';
import {
  applyProductionStoragePolicies,
  POLICY_SQL_PATH,
} from './production-platform-policy-runner.ts';

describe('Storage policy固定write runner', () => {
  it('固定ファイルと最小TLS環境だけを子processへ渡しCOMMIT markerを確認する', async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ stdout: 'STORAGE_POLICY_TRANSACTION_COMMITTED\n', stderr: '' });
    await applyProductionStoragePolicies('fixture-db-password', executor);
    const [file, args, options] = executor.mock.calls[0]!;
    expect(file).toBe('/usr/lib/postgresql/16/bin/psql');
    expect(args).toEqual([
      '-X',
      '--no-password',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      POLICY_SQL_PATH,
    ]);
    expect(options.env).toMatchObject({
      PGSSLMODE: 'verify-full',
      PGPASSWORD: 'fixture-db-password',
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
    expect(options.timeout).toBe(30000);
    expect(options.maxBuffer).toBe(32768);
  });
  it('COMMIT不明やSQLerrorをそのまま出力せず結果不明で停止する', async () => {
    const badOutput = vi.fn().mockResolvedValue({ stdout: '', stderr: 'private-error' });
    const rejected = vi.fn().mockRejectedValue(new Error('private-error'));
    for (const executor of [badOutput, rejected]) {
      await expect(applyProductionStoragePolicies('fixture-db-password', executor)).rejects.toThrow(
        'STORAGE_POLICY_WRITE_RESULT_UNKNOWN',
      );
      expect(executor).toHaveBeenCalledTimes(1);
    }
  });
});
