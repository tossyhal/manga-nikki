import { z } from 'zod';
import type { Entry, EntryDetail } from '../../shared/schemas';
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
function session() {
  const key = 'manga-nikki.mock-session';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return `mock:${id}`;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const fallback = '通信に失敗しました。入力内容を保持したまま再操作してください。';
  let response: Response | undefined;
  let result: unknown;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${session()}`);
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

export type CreateEntryInput = {
  createRequestId: string;
  diaryDate: string;
  body: string;
  consentVersion: 'v1';
};

const pendingCreateKey = 'manga-nikki.pending-entry-create';

async function fingerprintPayload(payload: {
  diaryDate: string;
  body: string;
  consentVersion: 'v1';
}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Keeps the create request ID across a reload so a lost response can be retried
 * without creating a duplicate diary. A changed payload receives a new ID.
 */
export async function createEntry(input: CreateEntryInput): Promise<Entry> {
  const payload = {
    diaryDate: input.diaryDate,
    body: input.body,
    consentVersion: input.consentVersion,
  };
  let requestId = input.createRequestId;
  let fingerprint: string | null = null;
  try {
    fingerprint = await fingerprintPayload(payload);
  } catch {
    // Continue without reload-safe retry if Web Crypto is unavailable.
  }

  if (fingerprint !== null) {
    try {
      const stored = sessionStorage.getItem(pendingCreateKey);
      if (stored) {
        const pending: unknown = JSON.parse(stored);
        if (
          typeof pending === 'object' &&
          pending !== null &&
          'requestId' in pending &&
          'fingerprint' in pending &&
          typeof pending.requestId === 'string' &&
          pending.fingerprint === fingerprint
        ) {
          requestId = pending.requestId;
        } else if (
          typeof pending === 'object' &&
          pending !== null &&
          'requestId' in pending &&
          'fingerprint' in pending &&
          typeof pending.requestId === 'string' &&
          typeof pending.fingerprint === 'string'
        ) {
          // The pending request belongs to different diary content.
          requestId = crypto.randomUUID();
        }
      }
      sessionStorage.setItem(pendingCreateKey, JSON.stringify({ requestId, fingerprint }));
    } catch {
      // Storage may be unavailable (for example, in a restricted browser context).
      // The request can still proceed, but reload-safe retry is then unavailable.
    }
  }

  try {
    const entry = await api<Entry>('/entries', {
      method: 'POST',
      body: JSON.stringify({ ...payload, createRequestId: requestId }),
    });
    try {
      const stored = sessionStorage.getItem(pendingCreateKey);
      if (stored && (JSON.parse(stored) as { requestId?: string }).requestId === requestId) {
        sessionStorage.removeItem(pendingCreateKey);
      }
    } catch {
      // A stale retry key is harmless; the server enforces request idempotency.
    }
    return entry;
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      error.status !== null &&
      error.status >= 400 &&
      error.status < 500
    ) {
      try {
        const stored = sessionStorage.getItem(pendingCreateKey);
        if (stored && (JSON.parse(stored) as { requestId?: string }).requestId === requestId) {
          sessionStorage.removeItem(pendingCreateKey);
        }
      } catch {
        // Ignore storage cleanup failures.
      }
    }
    throw error;
  }
}

export const getAssetUrl = (id: string) =>
  api<{ url: string; expiresAt: string }>(`/assets/${encodeURIComponent(id)}/url`);
export async function generate(entry: Entry) {
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
