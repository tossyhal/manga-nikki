import type { Plugin } from 'vite';

export const publicEnvironmentVariables = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY',
] as const;

export const PRODUCTION_SUPABASE_URL = 'https://leihsygtsamxffyybskh.supabase.co';
export const PRODUCTION_WORKER_HOSTNAME = 'manga-nikki.tossyhal.workers.dev';

const turnstileTestSiteKeys = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
]);

const publicKeyError = (variable: string) =>
  `${variable}にサーバー専用キー形式の値を設定できません。公開設定を確認してください。`;

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

function hasKnownServerKeyFormat(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  return (
    normalized.startsWith('sb_secret_') ||
    normalized.startsWith('sk-') ||
    hasServiceRoleJwt(normalized)
  );
}

export function assertNoKnownServerKeyFormats(environment: Record<string, string>): void {
  for (const variable of publicEnvironmentVariables) {
    if (hasKnownServerKeyFormat(environment[variable])) {
      throw new Error(publicKeyError(variable));
    }
  }
}

export function assertDemoSupabaseUrlUsesHttps(environment: Record<string, string>): void {
  let url: URL;
  try {
    url = new URL(environment.VITE_SUPABASE_URL?.trim() ?? '');
  } catch {
    throw new Error('demoのVITE_SUPABASE_URLにはHTTPSの有効なURLを設定してください。');
  }

  if (url.protocol !== 'https:') {
    throw new Error('demoのVITE_SUPABASE_URLにはHTTPSの有効なURLを設定してください。');
  }
}

function isAnonJwt(value: string): boolean {
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return false;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'role' in payload &&
      payload.role === 'anon'
    );
  } catch {
    return false;
  }
}

function isPublishableKey(value: string): boolean {
  return (
    (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value) && value.length > 'sb_publishable_'.length) ||
    isAnonJwt(value)
  );
}

function assertUnpaddedSingleLine(value: string | undefined, variable: string): string {
  const normalized = value ?? '';
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${variable}のproduction設定が不正です。`);
  }
  return normalized;
}

export function assertProductionPublicConfiguration(environment: Record<string, string>): void {
  const url = assertUnpaddedSingleLine(environment.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL');
  if (url !== PRODUCTION_SUPABASE_URL) {
    throw new Error('VITE_SUPABASE_URLのproduction設定が不正です。');
  }

  const publishableKey = assertUnpaddedSingleLine(
    environment.VITE_SUPABASE_PUBLISHABLE_KEY,
    'VITE_SUPABASE_PUBLISHABLE_KEY',
  );
  if (!isPublishableKey(publishableKey)) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEYの形式がproduction用ではありません。');
  }

  const siteKey = assertUnpaddedSingleLine(
    environment.VITE_TURNSTILE_SITE_KEY,
    'VITE_TURNSTILE_SITE_KEY',
  );
  if (siteKey.length > 32 || !/^[A-Za-z0-9_-]+$/.test(siteKey)) {
    throw new Error('VITE_TURNSTILE_SITE_KEYの形式がproduction用ではありません。');
  }
  if (turnstileTestSiteKeys.has(siteKey)) {
    throw new Error('VITE_TURNSTILE_SITE_KEYにTurnstile test keyは使用できません。');
  }
}

export function publicConfigGuard(): Plugin {
  return {
    name: 'manga-nikki-public-config-guard',
    enforce: 'pre',
    configResolved(config) {
      assertNoKnownServerKeyFormats(config.env);
      if (config.mode === 'demo') assertDemoSupabaseUrlUsesHttps(config.env);
      if (process.env.MANGA_NIKKI_RELEASE_TARGET === 'production') {
        assertProductionPublicConfiguration(config.env);
      }
    },
  };
}
