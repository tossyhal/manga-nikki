import type { Plugin } from 'vite';

export const publicEnvironmentVariables = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY',
] as const;

const publicKeyError = (variable: string) =>
  `${variable}にSupabaseサーバー専用キー形式の値を設定できません。公開設定を確認してください。`;

function hasServiceRoleJwt(value: string): boolean {
  const segments = value.split('.');
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'role' in payload &&
      payload.role === 'service_role'
    );
  } catch {
    return false;
  }
}

function hasKnownSupabaseServerKeyFormat(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  return normalized.startsWith('sb_secret_') || hasServiceRoleJwt(normalized);
}

export function assertNoKnownSupabaseServerKeyFormats(environment: Record<string, string>): void {
  for (const variable of publicEnvironmentVariables) {
    if (hasKnownSupabaseServerKeyFormat(environment[variable])) {
      throw new Error(publicKeyError(variable));
    }
  }
}

export function publicConfigGuard(): Plugin {
  return {
    name: 'manga-nikki-public-config-guard',
    enforce: 'pre',
    configResolved(config) {
      assertNoKnownSupabaseServerKeyFormats(config.env);
    },
  };
}
