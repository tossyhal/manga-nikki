import { z } from 'zod';
import type { Entry, EntryDetail } from '../../shared/schemas';
import { ClientAuthError, getLiveAccessToken } from './auth';
import { getClientConfig } from './config';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
    public readonly requestId: string | null = null,
    public readonly retryable: boolean | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function mockSession() {
  const key = 'manga-nikki.mock-session';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return `mock:${id}`;
}

async function authorizationFor(mode: 'mock' | 'live' | 'sample'): Promise<string> {
  if (mode === 'mock') {
    if (!import.meta.env.DEV) {
      throw new ApiClientError(
        '開発用モック認証は公開ビルドで利用できません。',
        503,
        'MOCK_AUTH_DISABLED',
      );
    }
    return `Bearer ${mockSession()}`;
  }
  if (mode === 'sample') {
    throw new ApiClientError('サンプル環境では個人データを操作できません。', 503, 'SAMPLE_ONLY');
  }
  try {
    const token = await getLiveAccessToken();
    if (!token) {
      throw new ApiClientError(
        '匿名セッションがありません。同意と登録用CAPTCHAを確認してから操作してください。',
        401,
        'AUTH_REQUIRED',
      );
    }
    return `Bearer ${token}`;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (error instanceof ClientAuthError)
      throw new ApiClientError(error.message, null, 'AUTH_UNAVAILABLE');
    throw new ApiClientError(
      '匿名セッションを確認できません。自動で別アカウントは作成しません。',
      null,
      'AUTH_UNAVAILABLE',
    );
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const fallback = '通信に失敗しました。入力内容を保持したまま再操作してください。';
  const config = await getClientConfig().catch(() => {
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  const authorization = await authorizationFor(config.dataMode);
  let response: Response | undefined;
  let result: unknown;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', authorization);
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers,
    });
    result = await response.json();
  } catch {
    throw new ApiClientError(fallback, response?.status ?? null);
  }
  if (!response.ok) {
    const failure = z
      .object({
        error: z.object({
          message: z.string(),
          code: z.string(),
          requestId: z.string(),
          retryable: z.boolean(),
        }),
      })
      .safeParse(result);
    if (failure.success) {
      const { message, code, requestId, retryable } = failure.data.error;
      if (response.status === 401 && config.dataMode === 'live') {
        throw new ApiClientError(
          '匿名セッションを確認できません。自動で別アカウントは作成しません。セッションを失うと過去の記録を復旧できない場合があります。',
          response.status,
          code,
          requestId,
          retryable,
        );
      }
      throw new ApiClientError(message, response.status, code, requestId, retryable);
    }
    throw new ApiClientError(fallback, response.status);
  }
  return result as T;
}
export const getEntry = (id: string) => api<EntryDetail>(`/entries/${encodeURIComponent(id)}`);
export function getEntries({ cursor, limit }: { cursor?: string; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (limit !== undefined) query.set('limit', String(limit));
  return api<{ items: Entry[]; nextCursor: string | null }>(`/entries?${query}`);
}
export const getAssetUrl = (id: string) =>
  api<{ url: string; expiresAt: string }>(`/assets/${encodeURIComponent(id)}/url`);
export async function generate(entry: Entry) {
  const config = await getClientConfig().catch(() => {
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  if (!config.generationAvailable) {
    throw new ApiClientError('この環境では漫画生成を利用できません。', 503, 'GENERATION_DISABLED');
  }
  if (config.dataMode !== 'mock') {
    throw new ApiClientError(
      '実AI生成は生成用CAPTCHAとの接続が未対応のため停止しています。',
      503,
      'GENERATION_CAPTCHA_UNAVAILABLE',
    );
  }
  const storageKey = `manga-nikki.generation:${entry.id}:${entry.revision}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  await api(`/entries/${entry.id}/generations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ expectedRevision: entry.revision, captchaToken: '' }),
  });
}
