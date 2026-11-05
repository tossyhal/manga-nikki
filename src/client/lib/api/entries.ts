import type { Entry, EntryDetail } from '../../../shared/schemas';
import { api, ApiClientError } from './client';

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
type PendingCreateRequest = { requestId: string; fingerprint: string };

function readPendingCreateRequests(): PendingCreateRequest[] {
  try {
    const stored = sessionStorage.getItem(pendingCreateKey);
    if (!stored) return [];
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return [];
    if ('pending' in value && Array.isArray(value.pending)) {
      return value.pending.filter(
        (item): item is PendingCreateRequest =>
          typeof item === 'object' &&
          item !== null &&
          'requestId' in item &&
          typeof item.requestId === 'string' &&
          'fingerprint' in item &&
          typeof item.fingerprint === 'string',
      );
    }
    if (
      'requestId' in value &&
      typeof value.requestId === 'string' &&
      'fingerprint' in value &&
      typeof value.fingerprint === 'string'
    ) {
      return [{ requestId: value.requestId, fingerprint: value.fingerprint }];
    }
  } catch {
    // Ignore malformed or inaccessible session storage.
  }
  return [];
}

function writePendingCreateRequests(pending: PendingCreateRequest[]) {
  try {
    if (pending.length === 0) sessionStorage.removeItem(pendingCreateKey);
    else sessionStorage.setItem(pendingCreateKey, JSON.stringify({ version: 1, pending }));
  } catch {
    // The request can still proceed without reload-safe retry if storage is unavailable.
  }
}

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
    const pending = readPendingCreateRequests();
    const previous = pending.find((item) => item.fingerprint === fingerprint);
    if (previous) requestId = previous.requestId;
    else {
      if (pending.length > 0) requestId = crypto.randomUUID();
      pending.push({ requestId, fingerprint });
    }
    writePendingCreateRequests(pending);
  }

  try {
    const entry = await api<Entry>('/entries', {
      method: 'POST',
      body: JSON.stringify({ ...payload, createRequestId: requestId }),
    });
    if (fingerprint !== null) {
      const pending = readPendingCreateRequests().filter(
        (item) => item.fingerprint !== fingerprint || item.requestId !== requestId,
      );
      writePendingCreateRequests(pending);
    }
    return entry;
  } catch (error) {
    if (
      fingerprint !== null &&
      error instanceof ApiClientError &&
      error.status === 404 &&
      error.code === 'NOT_FOUND'
    ) {
      const pending = readPendingCreateRequests();
      const index = pending.findIndex(
        (item) => item.fingerprint === fingerprint && item.requestId === requestId,
      );
      const staleRequest = pending[index];
      if (staleRequest) {
        pending[index] = { ...staleRequest, requestId: crypto.randomUUID() };
        writePendingCreateRequests(pending);
      }
    }
    throw error;
  }
}
