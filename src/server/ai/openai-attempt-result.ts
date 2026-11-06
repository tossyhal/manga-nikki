import type { ProviderCallMetadata, ProviderStage, ProviderUsage } from './provider-attempts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeProviderRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const requestId = value.trim();
  return requestId.length > 0 && requestId.length <= 200 ? requestId : undefined;
}

export function providerRequestIdFromError(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return safeProviderRequestId(error.requestID ?? error.request_id);
}

export function providerUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const [source, target] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const) {
    const tokens = value[source];
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0)
      usage[target] = tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function providerResponseMetadata(
  stage: ProviderStage,
  callIndex: number,
  modelId: string,
  requestId: unknown,
  usage: unknown,
): ProviderCallMetadata {
  const metadata: {
    stage: ProviderStage;
    callIndex: number;
    modelId: string;
    requestId?: string;
    usage?: ProviderUsage;
  } = { stage, callIndex, modelId };
  const safeRequestId = safeProviderRequestId(requestId);
  if (safeRequestId) metadata.requestId = safeRequestId;
  const safeUsage = providerUsage(usage);
  if (safeUsage) metadata.usage = safeUsage;
  return metadata;
}

export function providerFailureOutcome(error: unknown): {
  state: 'failed' | 'unknown';
  requestId?: string;
} {
  const status = isRecord(error) ? error.status : undefined;
  const outcome: { state: 'failed' | 'unknown'; requestId?: string } = {
    state:
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 409
        ? 'failed'
        : 'unknown',
  };
  const requestId = providerRequestIdFromError(error);
  if (requestId) outcome.requestId = requestId;
  return outcome;
}
