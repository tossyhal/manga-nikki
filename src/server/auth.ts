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

export async function verifySupabaseAccessToken(
  environment: Environment,
  token: string,
  fetcher?: typeof fetch,
): Promise<string> {
  let issuer: string;
  let client: ReturnType<typeof createUserSupabaseClient>;
  try {
    issuer = expectedSupabaseIssuer(environment);
    client = createUserSupabaseClient(environment, token, fetcher);
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

  return claims.sub as string;
}
