import type { SupabaseClient } from '@supabase/supabase-js';
import { getClientConfig } from './config';

export class ClientAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientAuthError';
  }
}

const sessionUnavailableMessage =
  '匿名セッションを確認できません。通信を確認してください。本文はこの画面に残っています。もう一度「下書き保存」を押してください。';
const configUnavailableMessage =
  '現在、保存を利用できません。入力した本文はこの画面に残っています。時間をおいて、もう一度お試しください。';

let supabaseClientPromise: Promise<SupabaseClient> | null = null;
let registrationInFlight: Promise<string> | null = null;

async function getSupabaseClient(): Promise<SupabaseClient> {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) throw new ClientAuthError(configUnavailableMessage);
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) =>
        createClient(url, publishableKey, {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
          },
        }),
      )
      .catch(() => {
        supabaseClientPromise = null;
        throw new ClientAuthError(configUnavailableMessage);
      });
  }
  return supabaseClientPromise;
}

async function assertLiveMode(): Promise<void> {
  const config = await getClientConfig();
  if (config.dataMode !== 'live') {
    throw new ClientAuthError('この環境では匿名セッションを利用できません。');
  }
}

async function readCurrentSession(): Promise<{ accessToken: string } | null> {
  await assertLiveMode();
  let result: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
  try {
    const client = await getSupabaseClient();
    result = await client.auth.getSession();
  } catch (error) {
    if (error instanceof ClientAuthError) throw error;
    throw new ClientAuthError(sessionUnavailableMessage);
  }
  if (result.error) throw new ClientAuthError(sessionUnavailableMessage);
  const token = result.data.session?.access_token;
  return token ? { accessToken: token } : null;
}

export async function getLiveAccessToken(): Promise<string | null> {
  const session = await readCurrentSession();
  return session?.accessToken ?? null;
}

export async function registerAnonymousSession(captchaToken: string): Promise<string> {
  if (!captchaToken.trim()) {
    throw new ClientAuthError('匿名登録には新しい登録用CAPTCHAの確認が必要です。');
  }
  if (registrationInFlight) return registrationInFlight;

  registrationInFlight = (async () => {
    const existing = await readCurrentSession();
    if (existing) return existing.accessToken;

    let result: Awaited<ReturnType<SupabaseClient['auth']['signInAnonymously']>>;
    try {
      const client = await getSupabaseClient();
      result = await client.auth.signInAnonymously({
        options: { captchaToken },
      });
    } catch {
      throw new ClientAuthError(
        '匿名登録に失敗しました。本文は画面に残っています。時間をおいて再試行してください。',
      );
    }
    if (result.error || !result.data.session?.access_token) {
      throw new ClientAuthError(
        '匿名登録に失敗しました。本文は画面に残っています。時間をおいて再試行してください。',
      );
    }
    return result.data.session.access_token;
  })();

  try {
    return await registrationInFlight;
  } finally {
    registrationInFlight = null;
  }
}
