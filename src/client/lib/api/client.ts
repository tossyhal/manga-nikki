import { z } from 'zod';
import { ClientAuthError, getLiveAccessToken } from '../auth';
import { getClientConfig, type ClientConfig } from '../config';
import { invalidateEntryReadCache } from './entryReadCache';

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

const apiErrorMessages: Record<string, string> = {
  AUTH_REQUIRED:
    '匿名セッションを確認できません。自動で別のアカウントは作成しません。ブラウザに保存済みのセッションを確認してください。',
  AUTH_EXPIRED: '匿名セッションの有効期限を確認できません。自動で別のアカウントは作成しません。',
  CAPTCHA_FAILED: '確認に失敗しました。新しい確認を取得して、もう一度お試しください。',
  CAPTCHA_REQUIRED: '生成用の新しい確認が必要です。新しい確認を取得してからお試しください。',
  CONSENT_REQUIRED: '利用条件の確認が必要です。内容を確認してから再操作してください。',
  DRAFT_LIMIT_REACHED: '未生成の記録が上限に達しています。不要な下書きを整理してください。',
  ENTRY_CREATE_RATE_LIMIT_REACHED: '本日の記録作成上限に達しています。明日以降にお試しください。',
  ENTRY_RETAINED_LIMIT_REACHED:
    '未回収の記録が上限に達しています。削除済みの記録が回収された後にお試しください。',
  ENTRY_BUSY: 'この記録の漫画を作成中です。最新の状態を確認してください。',
  GENERATION_DISABLED: '現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。',
  NO_GENERATION_REQUEST: '確認できる受付記録がありません。新しい確認を取得して再操作してください。',
  GLOBAL_LIMIT_REACHED: '現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。',
  IDEMPOTENCY_CONFLICT:
    '生成の受付結果を確認できませんでした。記録の最新状態を読み込んでください。',
  INPUT_TOO_LARGE: '本文を短くして、もう一度お試しください。',
  INVALID_INPUT: '入力内容を確認して、もう一度お試しください。',
  NOT_FOUND: '記録が見つかりません。保存した記録を読み込み直してください。',
  REVISION_CONFLICT: '記録が更新されています。最新の内容を読み込んでから操作してください。',
  REVISION_ALREADY_GENERATED:
    'この改訂版の漫画はすでに保存されています。最新の状態を読み込んでください。',
  TOO_MANY_ACTIVE: '別の漫画を作成しています。進行中の記録を開いて結果を確認してください。',
  USER_LIMIT_REACHED: '本日の生成上限に達しています。保存済みの記録は引き続き見られます。',
};

export type ApiAuthorizationScope = {
  dataMode: ClientConfig['dataMode'];
  authorization: string;
};

function errorMessageFor(status: number, code: string): string {
  const knownMessage = apiErrorMessages[code];
  if (knownMessage) return knownMessage;
  if (status === 401) return '匿名セッションを確認できません。自動で別のアカウントは作成しません。';
  if (status === 403) return '確認に失敗しました。新しい確認を取得して再操作してください。';
  if (status === 404) return '対象の記録が見つかりません。記録の一覧を確認してください。';
  if (status === 409) return '記録の状態が変わりました。最新の状態を読み込んでください。';
  if (status === 413) return '入力が大きすぎます。本文を短くしてください。';
  if (status === 429) return '利用上限に達しています。保存済みの記録は引き続き見られます。';
  if (status === 503) return '一時的に利用できません。時間をおいて再操作してください。';
  return '操作を完了できませんでした。通信と入力内容を確認して再操作してください。';
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

async function readAuthorizationScope(signal?: AbortSignal | null): Promise<ApiAuthorizationScope> {
  signal?.throwIfAborted();
  const config = await getClientConfig().catch(() => {
    signal?.throwIfAborted();
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  signal?.throwIfAborted();
  const authorization = await authorizationFor(config.dataMode).catch((failure: unknown) => {
    signal?.throwIfAborted();
    throw failure;
  });
  signal?.throwIfAborted();
  return { dataMode: config.dataMode, authorization };
}

export function getApiAuthorizationScope(): Promise<ApiAuthorizationScope> {
  return readAuthorizationScope();
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  hooks: {
    onRequestStart?: () => void;
    expectedScope?: ApiAuthorizationScope;
  } = {},
): Promise<T> {
  const fallback = '通信に失敗しました。入力内容を保持したまま再操作してください。';
  init.signal?.throwIfAborted();
  const scope = await readAuthorizationScope(init.signal);
  if (
    hooks.expectedScope &&
    (scope.dataMode !== hooks.expectedScope.dataMode ||
      scope.authorization !== hooks.expectedScope.authorization)
  ) {
    throw new ApiClientError(
      '認証状態が変わりました。画面を再読み込みしてからお試しください。',
      null,
      'AUTH_SCOPE_CHANGED',
    );
  }
  let response: Response | undefined;
  let result: unknown;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', scope.authorization);
  const method = (init.method ?? 'GET').toUpperCase();
  const invalidatesEntryReads =
    method !== 'GET' && (/^\/entries(?:\/|$)/.test(path) || /^\/generations(?:\/|$)/.test(path));
  try {
    hooks.onRequestStart?.();
    if (invalidatesEntryReads) invalidateEntryReadCache();
    try {
      response = await fetch(`/api/v1${path}`, {
        ...init,
        headers,
      });
      result = await response.json();
    } finally {
      if (invalidatesEntryReads) invalidateEntryReadCache();
    }
  } catch (failure) {
    if (response?.status === 401 || response?.status === 403) invalidateEntryReadCache();
    if (init.signal?.aborted) throw failure;
    throw new ApiClientError(fallback, response?.status ?? null);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) invalidateEntryReadCache();
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
      const { code, requestId, retryable } = failure.data.error;
      const message = errorMessageFor(response.status, code);
      if (response.status === 401 && scope.dataMode === 'live') {
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
