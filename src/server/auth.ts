import { z } from 'zod';
import type { Environment } from './mode';
import { createUserSupabaseClient, expectedSupabaseIssuer } from './supabase-clients';

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('AUTH_REQUIRED');
  }
}

export class SupabaseAuthUnavailableError extends Error {
  constructor() {
    super('DEPENDENCY_UNAVAILABLE');
  }
}

const bearerPattern = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const userIdSchema = z.uuid();

export function getBearerToken(header: string | undefined): string {
  const token = header?.match(bearerPattern)?.[1];
  if (!token) throw new InvalidAccessTokenError();
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableAuthError(error: { name?: string; status?: number }): boolean {
  return (
    error.name === 'AuthRetryableFetchError' ||
    error.name === 'AuthUnknownError' ||
    (typeof error.status === 'number' &&
      (error.status === 0 || error.status === 429 || error.status >= 500))
  );
}

function createRequestScopedAuthUserFetch(
  fetcher: typeof fetch,
  userUrl: string,
  token: string,
): typeof fetch {
  let successfulResponse: Response | undefined;
  return async (input, init) => {
    let url: string;
    let method: string;
    let headers: Headers;
    try {
      if (typeof input === 'string') url = new URL(input).href;
      else if (input instanceof URL) url = input.href;
      else url = input.url;
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
    } catch {
      return fetcher(input, init);
    }
    const signal =
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined;
    if (
      method.toUpperCase() !== 'GET' ||
      url !== userUrl ||
      headers.get('authorization') !== `Bearer ${token}`
    )
      return fetcher(input, init);

    if (successfulResponse && !signal?.aborted) return successfulResponse.clone();
    const response = await fetcher(input, init);
    if (response.status === 200 && !signal?.aborted) successfulResponse = response.clone();
    return response;
  };
}

export async function verifySupabaseAccessToken(
  environment: Environment,
  token: string,
  fetcher?: typeof fetch,
): Promise<string> {
  let issuer: string;
  let client: ReturnType<typeof createUserSupabaseClient>;
  try {
    issuer = expectedSupabaseIssuer(environment);
    // HS256のgetClaimsが同じtokenでGET /userするため、このverify呼び出し内の成功応答だけを再利用する。
    const scopedFetcher = createRequestScopedAuthUserFetch(
      fetcher ?? fetch,
      `${issuer}/user`,
      token,
    );
    client = createUserSupabaseClient(environment, token, scopedFetcher);
  } catch {
    throw new SupabaseAuthUnavailableError();
  }

  let result: Awaited<ReturnType<typeof client.auth.getClaims>>;
  try {
    result = await client.auth.getClaims(token);
  } catch (error) {
    if (isRecord(error) && error.name === 'AuthInvalidJwtError')
      throw new InvalidAccessTokenError();
    throw new SupabaseAuthUnavailableError();
  }

  if (result.error) {
    if (isRetryableAuthError(result.error)) throw new SupabaseAuthUnavailableError();
    throw new InvalidAccessTokenError();
  }
  if (!result.data || !isRecord(result.data.claims)) throw new InvalidAccessTokenError();

  const claims = result.data.claims;
  const audience = claims.aud;
  const validAudience =
    audience === 'authenticated' || (Array.isArray(audience) && audience.includes('authenticated'));
  if (
    claims.iss !== issuer ||
    !validAudience ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000) ||
    !userIdSchema.safeParse(claims.sub).success
  )
    throw new InvalidAccessTokenError();

  let currentUser: Awaited<ReturnType<typeof client.auth.getUser>>;
  try {
    currentUser = await client.auth.getUser(token);
  } catch (error) {
    if (isRecord(error) && error.name === 'AuthInvalidJwtError')
      throw new InvalidAccessTokenError();
    throw new SupabaseAuthUnavailableError();
  }
  if (currentUser.error) {
    if (isRetryableAuthError(currentUser.error)) throw new SupabaseAuthUnavailableError();
    throw new InvalidAccessTokenError();
  }
  if (!currentUser.data.user || currentUser.data.user.id !== claims.sub)
    throw new InvalidAccessTokenError();

  return claims.sub as string;
}
