import {
  PRODUCTION_SAMPLE_PROFILE,
  SAMPLE_DEPLOYMENT_GITHUB_API,
  SAMPLE_DEPLOYMENT_REPOSITORY,
  type SampleDeploymentContext,
} from './sample-deployment.ts';

export type ProductionSamplePreflightErrorCode =
  | 'INPUT_CONTEXT_INVALID'
  | 'INPUT_SHA_INVALID'
  | 'INPUT_GITHUB_TOKEN_MISSING'
  | 'INPUT_GITHUB_TOKEN_INVALID'
  | 'INPUT_WORKER_URL_INVALID'
  | 'INPUT_SECRET_ID_INVALID'
  | 'GITHUB_REQUEST_FAILED'
  | 'GITHUB_RESPONSE_INVALID'
  | 'GITHUB_API_FAILED';

export class ProductionSamplePreflightFailure extends Error {
  readonly code: ProductionSamplePreflightErrorCode;

  constructor(code: ProductionSamplePreflightErrorCode) {
    super(code);
    this.name = 'ProductionSamplePreflightFailure';
    this.code = code;
  }
}

export type ProductionSamplePreflightContext = SampleDeploymentContext & {
  productionSampleCdEnabled?: string;
  bwsCloudflareSecretId?: string;
};

export type ProductionSamplePreflightResult = Readonly<{
  commit: string;
  deployment: 'ready' | 'skipped';
  skipReason?: 'flag-disabled' | 'stale-main';
}>;

export type ProductionSamplePreflightDependencies = {
  githubFetcher?: (input: string, init: RequestInit) => Promise<Response>;
};

const MAX_RESPONSE_BYTES = 16 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: ProductionSamplePreflightErrorCode): never {
  throw new ProductionSamplePreflightFailure(code);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return fail('GITHUB_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail('GITHUB_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
  } catch {
    return fail('GITHUB_RESPONSE_INVALID');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('GITHUB_RESPONSE_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('GITHUB_RESPONSE_INVALID');
  }
  return parsed as Record<string, unknown>;
}

function validateContext(context: ProductionSamplePreflightContext): {
  commit: string;
} {
  if (
    context.githubActions !== 'true' ||
    context.githubRepository !== SAMPLE_DEPLOYMENT_REPOSITORY ||
    context.githubRef !== PRODUCTION_SAMPLE_PROFILE.ref ||
    (context.githubEventName !== 'push' && context.githubEventName !== 'workflow_dispatch') ||
    context.githubActorId !== PRODUCTION_SAMPLE_PROFILE.authorizedActorId ||
    context.githubTriggeringActor !== PRODUCTION_SAMPLE_PROFILE.triggeringActor
  ) {
    return fail('INPUT_CONTEXT_INVALID');
  }

  const commit = context.githubSha;
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) return fail('INPUT_SHA_INVALID');
  return { commit: commit.toLowerCase() };
}

export async function checkProductionSamplePreflight(
  context: ProductionSamplePreflightContext,
  dependencies: ProductionSamplePreflightDependencies = {},
): Promise<ProductionSamplePreflightResult> {
  const { commit } = validateContext(context);
  if (context.productionSampleCdEnabled !== 'true') {
    return { commit, deployment: 'skipped', skipReason: 'flag-disabled' };
  }
  if (context.workerUrl !== PRODUCTION_SAMPLE_PROFILE.workerUrl) {
    return fail('INPUT_WORKER_URL_INVALID');
  }
  if (!context.bwsCloudflareSecretId || !uuidPattern.test(context.bwsCloudflareSecretId)) {
    return fail('INPUT_SECRET_ID_INVALID');
  }
  const githubToken = context.githubToken;
  if (!githubToken || githubToken.trim() === '') return fail('INPUT_GITHUB_TOKEN_MISSING');
  if (githubToken.trim() !== githubToken || /[\r\n]/.test(githubToken)) {
    return fail('INPUT_GITHUB_TOKEN_INVALID');
  }
  const fetcher = dependencies.githubFetcher ?? fetch;
  const url = `${SAMPLE_DEPLOYMENT_GITHUB_API}/repos/${SAMPLE_DEPLOYMENT_REPOSITORY}/git/ref/${PRODUCTION_SAMPLE_PROFILE.githubRef}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail('GITHUB_REQUEST_FAILED');
  }

  const body = await readJson(response);
  if (!response.ok) return fail('GITHUB_API_FAILED');
  const object = body.object;
  if (
    typeof object !== 'object' ||
    object === null ||
    Array.isArray(object) ||
    typeof (object as Record<string, unknown>).sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test((object as Record<string, unknown>).sha as string)
  ) {
    return fail('GITHUB_RESPONSE_INVALID');
  }
  const head = ((object as Record<string, unknown>).sha as string).toLowerCase();
  return head === commit
    ? { commit, deployment: 'ready' }
    : { commit, deployment: 'skipped', skipReason: 'stale-main' };
}
