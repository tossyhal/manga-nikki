import type { Environment } from './mode';
import { createServerRpcClient } from './supabase-clients';
import { createServerComicStorageClient } from './supabase-storage';

const maxImageBytes = 8 * 1024 * 1024;
export const saveLeaseMs = 120_000;

export type GenerationSaveBackend = Readonly<{
  callRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  upload(path: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}>;

export type GenerationSaveBackendFactory = (
  environment: Environment,
  signal: AbortSignal,
) => GenerationSaveBackend;

export class GenerationSaveDependencyError extends Error {
  constructor(
    readonly kind: 'rpc' | 'storage',
    readonly status?: number,
    readonly serviceCode?: string,
  ) {
    super('GENERATION_SAVE_DEPENDENCY_UNAVAILABLE');
    this.name = 'GenerationSaveDependencyError';
  }
}

export class MissingStoredImageError extends Error {
  constructor() {
    super('GENERATION_SAVE_IMAGE_MISSING');
  }
}

export class InvalidStoredImageError extends Error {
  constructor() {
    super('GENERATION_SAVE_IMAGE_INVALID');
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { status?: unknown; statusCode?: unknown };
  for (const candidate of [value.statusCode, value.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function serviceErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { code?: unknown; statusCode?: unknown };
  if (typeof value.code === 'string') return value.code;
  if (typeof value.statusCode === 'string') return value.statusCode;
  return undefined;
}

export function isMissingStorageObject(error: unknown): boolean {
  if (!(error instanceof GenerationSaveDependencyError) || error.kind !== 'storage') return false;
  return error.serviceCode === 'NoSuchKey' || error.serviceCode === 'ObjectNotFound';
}

function dependencyStatus(error: GenerationSaveDependencyError): number | undefined {
  if (error.serviceCode && /^\d{3}$/.test(error.serviceCode)) return Number(error.serviceCode);
  return error.status;
}

function combineAbortSignals(parent: AbortSignal, input?: AbortSignal): AbortSignal {
  if (!input || parent === input) return parent;
  return AbortSignal.any([parent, input]);
}

export function fetchWithAbortSignal(fetcher: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => {
    const requestSignal =
      init?.signal ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    return fetcher(input, {
      ...init,
      signal: combineAbortSignals(signal, requestSignal),
    });
  };
}

export function createSupabaseGenerationSaveBackend(
  environment: Environment,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): GenerationSaveBackend {
  const abortableFetch = fetchWithAbortSignal(fetcher, signal);
  const rpc = createServerRpcClient(environment, abortableFetch);
  const storage = createServerComicStorageClient(environment, abortableFetch);
  return {
    async callRpc(name, args) {
      const { data, error } = await rpc.rpc(name, args);
      if (error)
        throw new GenerationSaveDependencyError('rpc', statusCode(error), serviceErrorCode(error));
      return data;
    },
    async upload(path, bytes, mediaType) {
      const { error } = await storage.upload(path, bytes, mediaType);
      if (error)
        throw new GenerationSaveDependencyError(
          'storage',
          statusCode(error),
          serviceErrorCode(error),
        );
    },
    async download(path) {
      const { data, error } = await storage.download(path, signal);
      if (error)
        throw new GenerationSaveDependencyError(
          'storage',
          statusCode(error),
          serviceErrorCode(error),
        );
      if (data.size > maxImageBytes) throw new InvalidStoredImageError();
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

export function createOperationSignal(
  parent: AbortSignal,
  deadlines: readonly (string | number)[],
): { signal: AbortSignal; dispose(): void } {
  const now = Date.now();
  const deadlineTimes = deadlines.map((value) =>
    typeof value === 'number' ? value : Date.parse(value),
  );
  if (deadlineTimes.some((value) => !Number.isFinite(value)))
    throw new Error('GENERATION_SAVE_DEADLINE_INVALID');
  const deadline = Math.min(...deadlineTimes, now + saveLeaseMs);
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(parent.reason ?? new DOMException('Save operation cancelled', 'AbortError'));
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const abortOnDeadline = () =>
    controller.abort(new DOMException('Save lease deadline exceeded', 'TimeoutError'));
  const timeout =
    deadline <= now ? (abortOnDeadline(), undefined) : setTimeout(abortOnDeadline, deadline - now);
  return {
    signal: controller.signal,
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

export function assertOperationActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException('Save operation cancelled', 'AbortError');
}

export function isTemporary(error: unknown): boolean {
  if (error instanceof GenerationSaveDependencyError && error.kind === 'rpc') return true;
  if (error instanceof GenerationSaveDependencyError && error.kind === 'storage') {
    const status = dependencyStatus(error);
    return (
      status === undefined ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 408 ||
      status === 429 ||
      status >= 500
    );
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
