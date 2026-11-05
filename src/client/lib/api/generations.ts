import type { Entry, Generation } from '../../../shared/schemas';
import { getLiveAccessToken } from '../auth';
import { getClientConfig } from '../config';
import { api, ApiClientError } from './client';

export type GenerationQuota = {
  remainingToday: number;
  activeGenerationId: string | null;
  resetAt: string;
  generationAvailable: boolean;
};

export type GenerationReceipt = {
  generationId: string;
  status: Generation['status'];
  statusUrl: string;
};

export const getGeneration = (id: string) =>
  api<Generation>(`/generations/${encodeURIComponent(id)}`);
export const getQuota = () => api<GenerationQuota>('/me/quota');

export async function getQuotaForExistingSession(): Promise<GenerationQuota | null> {
  const config = await getClientConfig().catch(() => {
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  if (config.dataMode === 'sample') return null;
  if (config.dataMode === 'live' && !(await getLiveAccessToken())) return null;
  return getQuota();
}

function generationStorageKey(entry: Pick<Entry, 'id' | 'revision'>): string {
  return `manga-nikki.generation:${entry.id}:${entry.revision}`;
}

function generationKey(entry: Entry): string {
  const storageKey = generationStorageKey(entry);
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  return key;
}

export function hasGenerationRequest(entry: Entry): boolean {
  return sessionStorage.getItem(generationStorageKey(entry)) !== null;
}

async function postGeneration(entry: Entry, captchaToken: string): Promise<GenerationReceipt> {
  const config = await getClientConfig().catch(() => {
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  if (config.dataMode === 'sample') {
    throw new ApiClientError('サンプル環境では個人データを操作できません。', 503, 'SAMPLE_ONLY');
  }
  if (!config.generationAvailable) {
    throw new ApiClientError('この環境では漫画生成を利用できません。', 503, 'GENERATION_DISABLED');
  }
  if (config.dataMode === 'live' && !captchaToken.trim()) {
    throw new ApiClientError(
      '新しい生成用の確認が必要です。結果の再確認には「受付結果を確認」を選んでください。',
      403,
      'CAPTCHA_REQUIRED',
    );
  }
  return api<GenerationReceipt>(`/entries/${encodeURIComponent(entry.id)}/generations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': generationKey(entry) },
    body: JSON.stringify({ expectedRevision: entry.revision, captchaToken }),
  });
}

export function generate(entry: Entry, captchaToken = ''): Promise<GenerationReceipt> {
  return postGeneration(entry, captchaToken);
}

export async function recheckGeneration(entry: Entry): Promise<GenerationReceipt> {
  const config = await getClientConfig().catch(() => {
    throw new ApiClientError(
      '現在、読み込めません。通信を確認して再読み込みしてください。',
      null,
      'CONFIG_UNAVAILABLE',
    );
  });
  if (config.dataMode === 'sample') {
    throw new ApiClientError('サンプル環境では個人データを操作できません。', 503, 'SAMPLE_ONLY');
  }
  if (!hasGenerationRequest(entry)) {
    throw new ApiClientError('確認できる生成受付がありません。', 409, 'NO_GENERATION_REQUEST');
  }
  const key = sessionStorage.getItem(generationStorageKey(entry));
  if (!key)
    throw new ApiClientError('確認できる生成受付がありません。', 409, 'NO_GENERATION_REQUEST');
  return api<GenerationReceipt>(`/entries/${encodeURIComponent(entry.id)}/generations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ expectedRevision: entry.revision, captchaToken: '' }),
  });
}
