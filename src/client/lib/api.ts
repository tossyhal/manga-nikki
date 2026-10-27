import { z } from 'zod';
import type { Entry, EntryDetail } from '../../shared/schemas';
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
  let response: Response;
  let result: unknown;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session()}`,
        ...init.headers,
      },
    });
    result = await response.json();
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(result);
    throw new Error(failure.success ? failure.data.error.message : fallback);
  }
  return result as T;
}
export const getEntry = (id: string) => api<EntryDetail>(`/entries/${encodeURIComponent(id)}`);
export const getEntries = () => api<{ items: Entry[]; nextCursor: string | null }>('/entries');
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
