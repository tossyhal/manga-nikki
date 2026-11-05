import { describe, expect, it } from 'vitest';
import {
  assertNoKnownSupabaseServerKeyFormats,
  publicEnvironmentVariables,
} from './public-config-guard';

function jwtWithRole(role: string, extra: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ ...extra, role })).toString('base64url');
  return `header.${payload}.signature`;
}

function environmentWith(value: string): Record<string, string> {
  return Object.fromEntries(publicEnvironmentVariables.map((variable) => [variable, value]));
}

describe('公開環境変数の既知Supabase secret形式検査', () => {
  it('空欄・publishable key・旧anon key・未知形式・不正JWTは許可する', () => {
    for (const value of [
      '',
      '   ',
      'sb_publishable_test-sentinel',
      jwtWithRole('anon'),
      'opaque-test-sentinel',
      'header.not-json.signature',
      'not.a.jwt.with.extra-segments',
    ]) {
      expect(() => assertNoKnownSupabaseServerKeyFormats(environmentWith(value))).not.toThrow();
    }
  });

  it('3つの公開変数すべてでsb_secret_形式を拒否し、値を例外へ含めない', () => {
    const secretSentinel = 'sb_secret_test-sentinel';

    for (const variable of publicEnvironmentVariables) {
      expect(() =>
        assertNoKnownSupabaseServerKeyFormats({
          ...environmentWith(''),
          [variable]: ` ${secretSentinel} `,
        }),
      ).toThrow(variable);
      try {
        assertNoKnownSupabaseServerKeyFormats({
          ...environmentWith(''),
          [variable]: secretSentinel,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(secretSentinel);
      }
    }
  });

  it('3つの公開変数すべてでservice_role JWTを拒否し、payloadを例外へ含めない', () => {
    const jwtPayloadSentinel = 'payload-test-sentinel';
    const serviceRoleJwt = jwtWithRole('service_role', { marker: jwtPayloadSentinel });

    for (const variable of publicEnvironmentVariables) {
      let thrown: unknown;
      try {
        assertNoKnownSupabaseServerKeyFormats({
          ...environmentWith(''),
          [variable]: serviceRoleJwt,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(variable);
      expect((thrown as Error).message).not.toContain(jwtPayloadSentinel);
    }
  });
});
