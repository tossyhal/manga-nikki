import {
  checkProductionSamplePreflight,
  type ProductionSamplePreflightContext,
  type ProductionSamplePreflightDependencies,
} from './production-sample-preflight.ts';

export const OPENAI_READINESS_MODELS = ['gpt-4.1-mini-2025-04-14', 'gpt-image-2.5-flare'] as const;

type ModelId = (typeof OPENAI_READINESS_MODELS)[number];
export type ReadinessCode =
  | 'MODEL_VISIBLE'
  | 'MODEL_HTTP_FAILED'
  | 'MODEL_RESPONSE_INVALID'
  | 'MODEL_REQUEST_FAILED';
export type ModelReadiness = Readonly<{
  model: ModelId;
  code: ReadinessCode;
  status: number | null;
}>;
export class OpenaiReadinessFailure extends Error {
  readonly code: 'INPUT_CONTEXT_INVALID' | 'INPUT_API_KEY_INVALID' | 'STALE_MAIN';
  constructor(code: OpenaiReadinessFailure['code']) {
    super(code);
    this.code = code;
  }
}

export async function checkOpenaiReadinessGate(
  context: ProductionSamplePreflightContext,
  dependencies: ProductionSamplePreflightDependencies = {},
): Promise<void> {
  if (context.githubEventName !== 'workflow_dispatch') {
    throw new OpenaiReadinessFailure('INPUT_CONTEXT_INVALID');
  }
  const result = await checkProductionSamplePreflight(
    { ...context, productionSampleCdEnabled: 'true' },
    dependencies,
  );
  if (result.deployment !== 'ready') throw new OpenaiReadinessFailure('STALE_MAIN');
}

async function validModelBody(response: Response, model: ModelId): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).id === model &&
      (body as Record<string, unknown>).object === 'model'
    );
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

export async function checkOpenaiModels(
  apiKey: string | undefined,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<readonly ModelReadiness[]> {
  // 接頭辞だけで権限を断定せず、明示的な管理者キー形式を除外する。
  if (!apiKey || !/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey) || apiKey.startsWith('sk-admin')) {
    throw new OpenaiReadinessFailure('INPUT_API_KEY_INVALID');
  }
  const results: ModelReadiness[] = [];
  for (const model of OPENAI_READINESS_MODELS) {
    let status: number | null = null;
    try {
      const response = await fetcher(`https://api.openai.com/v1/models/${model}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        results.push({ model, status, code: 'MODEL_HTTP_FAILED' });
        continue;
      }
      results.push({
        model,
        status,
        code: (await validModelBody(response, model)) ? 'MODEL_VISIBLE' : 'MODEL_RESPONSE_INVALID',
      });
    } catch {
      results.push({ model, status, code: 'MODEL_REQUEST_FAILED' });
    }
  }
  return results;
}
