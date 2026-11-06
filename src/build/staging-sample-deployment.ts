export const STAGING_SAMPLE_REPOSITORY = 'tossyhal/manga-nikki';
export const STAGING_SAMPLE_REF = 'refs/heads/develop';
export const STAGING_SAMPLE_WORKER_NAME = 'manga-nikki-staging';
export const STAGING_SAMPLE_ACCOUNT_ID = 'c9cee9599752cb191815c0eea6ff457e';
export const STAGING_SAMPLE_WORKER_URL = 'https://manga-nikki-staging.tossyhal.workers.dev';
export const STAGING_SAMPLE_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const STAGING_SAMPLE_GITHUB_API = 'https://api.github.com';

export type StagingSampleDeploymentErrorCode =
  | 'INPUT_CONTEXT_INVALID'
  | 'INPUT_SHA_INVALID'
  | 'INPUT_GITHUB_TOKEN_MISSING'
  | 'INPUT_GITHUB_TOKEN_INVALID'
  | 'INPUT_CLOUDFLARE_TOKEN_MISSING'
  | 'INPUT_CLOUDFLARE_TOKEN_INVALID'
  | 'INPUT_WORKER_URL_INVALID'
  | 'GITHUB_REQUEST_FAILED'
  | 'GITHUB_RESPONSE_INVALID'
  | 'GITHUB_API_FAILED'
  | 'ARTIFACT_PREPARATION_FAILED'
  | 'ARTIFACT_MANIFEST_INVALID'
  | 'ARTIFACT_CONFIG_PATH_INVALID'
  | 'ARTIFACT_CONFIG_UNSAFE'
  | 'ARTIFACT_MARKER_WRITE_FAILED'
  | 'CLOUDFLARE_REQUEST_FAILED'
  | 'CLOUDFLARE_RESPONSE_INVALID'
  | 'CLOUDFLARE_API_FAILED'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_BINDINGS_PRESENT'
  | 'WRANGLER_RUNNER_MISSING'
  | 'WRANGLER_DEPLOY_FAILED'
  | 'WORKER_PUBLIC_URL_SETTINGS_INVALID'
  | 'WORKER_PUBLIC_URL_DISABLED'
  | 'WORKER_PREVIEW_URL_ENABLED'
  | 'SMOKE_REQUEST_FAILED'
  | 'SMOKE_RESPONSE_INVALID'
  | 'SMOKE_HEALTH_INVALID'
  | 'SMOKE_CONFIG_INVALID'
  | 'SMOKE_DEPLOYMENT_INVALID'
  | 'SMOKE_COMMIT_MISMATCH'
  | 'SMOKE_RETRIES_EXHAUSTED';

export type StagingSampleDeploymentDisplayErrorCode =
  | StagingSampleDeploymentErrorCode
  | 'INTERNAL_ERROR'
  | 'SUMMARY_WRITE_FAILED';

export class StagingSampleDeploymentFailure extends Error {
  readonly code: StagingSampleDeploymentErrorCode;

  constructor(code: StagingSampleDeploymentErrorCode) {
    super(code);
    this.name = 'StagingSampleDeploymentFailure';
    this.code = code;
  }
}

export type StagingSampleDeploymentContext = {
  githubActions?: string;
  githubRepository?: string;
  githubRef?: string;
  githubEventName?: string;
  githubSha?: string;
  githubToken?: string;
  cloudflareApiToken?: string;
  workerUrl?: string;
};

export type StagingSampleDeploymentProgress = {
  environment: 'staging';
  commit: string;
  url: string;
  deployment: 'not-run' | 'skipped' | 'attempted' | 'succeeded';
  smoke: 'not-run' | 'passed' | 'failed';
};

export type StagingSampleDeploymentResult = Readonly<StagingSampleDeploymentProgress>;

export type StagingSampleDeploymentDependencies = {
  githubFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  cloudflareFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  publicFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  prepareArtifact?: (commit: string) => Promise<{ configPath: string }>;
  deploy?: (configPath: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: StagingSampleDeploymentProgress) => void;
};

type JsonRecord = Record<string, unknown>;
type ApiEnvelope = JsonRecord & { success?: unknown; errors?: unknown; result?: unknown };

const MAX_API_RESPONSE_BYTES = 32 * 1024;
const MAX_SMOKE_RESPONSE_BYTES = 16 * 1024;
const SMOKE_ATTEMPTS = 5;
const SMOKE_RETRY_DELAY_MS = 3_000;
const expectedWorkerVars = {
  APP_ENV: 'staging',
  DATA_MODE: 'sample',
  AI_MODE: 'mock',
  GENERATION_ENABLED: 'false',
} as const;

function fail(code: StagingSampleDeploymentErrorCode): never {
  throw new StagingSampleDeploymentFailure(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSha(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) return fail('INPUT_SHA_INVALID');
  return value.toLowerCase();
}

function validateContext(context: StagingSampleDeploymentContext): {
  commit: string;
  githubToken: string;
  workerUrl: string;
} {
  if (
    context.githubActions !== 'true' ||
    context.githubRepository !== STAGING_SAMPLE_REPOSITORY ||
    context.githubRef !== STAGING_SAMPLE_REF ||
    (context.githubEventName !== 'push' && context.githubEventName !== 'workflow_dispatch')
  ) {
    return fail('INPUT_CONTEXT_INVALID');
  }

  const commit = validateSha(context.githubSha);
  const githubToken = context.githubToken;
  if (!githubToken || githubToken.trim() === '') return fail('INPUT_GITHUB_TOKEN_MISSING');
  if (githubToken.trim() !== githubToken || /[\r\n]/.test(githubToken)) {
    return fail('INPUT_GITHUB_TOKEN_INVALID');
  }

  if (context.workerUrl !== STAGING_SAMPLE_WORKER_URL) return fail('INPUT_WORKER_URL_INVALID');
  return { commit, githubToken, workerUrl: STAGING_SAMPLE_WORKER_URL };
}

function validateCloudflareToken(value: string | undefined): string {
  if (!value || value.trim() === '') return fail('INPUT_CLOUDFLARE_TOKEN_MISSING');
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    return fail('INPUT_CLOUDFLARE_TOKEN_INVALID');
  }
  return value;
}

async function readBoundedText(
  response: Response,
  limit: number,
  invalidCode: StagingSampleDeploymentErrorCode,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail(invalidCode);

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return fail(invalidCode);
      }
      chunks.push(value);
    }
  } catch {
    return fail(invalidCode);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(invalidCode);
  }
}

async function readJson(
  response: Response,
  limit: number,
  invalidCode: StagingSampleDeploymentErrorCode,
): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(response, limit, invalidCode));
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail(invalidCode);
  }
  if (!isRecord(parsed)) return fail(invalidCode);
  return parsed;
}

async function getJson(
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  input: string,
  token: string,
  errorCodes: {
    request: StagingSampleDeploymentErrorCode;
    response: StagingSampleDeploymentErrorCode;
    api: StagingSampleDeploymentErrorCode;
  },
): Promise<{ response: Response; body: ApiEnvelope }> {
  let response: Response;
  try {
    response = await fetcher(input, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail(errorCodes.request);
  }

  const body = (await readJson(
    response,
    MAX_API_RESPONSE_BYTES,
    errorCodes.response,
  )) as ApiEnvelope;
  if (!response.ok || body.success !== true || !isRecord(body.result)) return fail(errorCodes.api);
  return { response, body };
}

function readHeadSha(body: JsonRecord): string {
  const object = body.object;
  if (!isRecord(object) || typeof object.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(object.sha)) {
    return fail('GITHUB_RESPONSE_INVALID');
  }
  return object.sha.toLowerCase();
}

async function readDevelopHead(
  fetcher: NonNullable<StagingSampleDeploymentDependencies['githubFetcher']>,
  token: string,
): Promise<string> {
  const url = `${STAGING_SAMPLE_GITHUB_API}/repos/${STAGING_SAMPLE_REPOSITORY}/git/ref/heads/develop`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
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

  const body = await readJson(response, MAX_API_RESPONSE_BYTES, 'GITHUB_RESPONSE_INVALID');
  if (!response.ok) return fail('GITHUB_API_FAILED');
  return readHeadSha(body);
}

function cloudflareErrorCodes(body: ApiEnvelope): number[] {
  if (!Array.isArray(body.errors)) return [];
  return body.errors.flatMap((error) =>
    isRecord(error) && typeof error.code === 'number' ? [error.code] : [],
  );
}

function workerSettingsUrl(): string {
  return `${STAGING_SAMPLE_CLOUDFLARE_API}/accounts/${STAGING_SAMPLE_ACCOUNT_ID}/workers/scripts/${STAGING_SAMPLE_WORKER_NAME}/settings`;
}

function workerSubdomainUrl(): string {
  return `${STAGING_SAMPLE_CLOUDFLARE_API}/accounts/${STAGING_SAMPLE_ACCOUNT_ID}/workers/scripts/${STAGING_SAMPLE_WORKER_NAME}/subdomain`;
}

async function readWorkerSettingsAllowMissingAware(
  fetcher: NonNullable<StagingSampleDeploymentDependencies['cloudflareFetcher']>,
  token: string,
  requireStagingVars: boolean,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(workerSettingsUrl(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail('CLOUDFLARE_REQUEST_FAILED');
  }

  const body = (await readJson(
    response,
    MAX_API_RESPONSE_BYTES,
    'CLOUDFLARE_RESPONSE_INVALID',
  )) as ApiEnvelope;
  if (
    response.status === 404 &&
    body.success === false &&
    cloudflareErrorCodes(body).includes(10007)
  ) {
    return fail('WORKER_NOT_FOUND');
  }
  if (!response.ok || body.success !== true || !isRecord(body.result)) {
    return fail('CLOUDFLARE_API_FAILED');
  }

  const bindings = body.result.bindings;
  if (!Array.isArray(bindings)) return fail('CLOUDFLARE_RESPONSE_INVALID');
  const seenVars = new Set<string>();
  let assetsBindingCount = 0;
  for (const binding of bindings) {
    if (!isRecord(binding)) return fail('WORKER_BINDINGS_PRESENT');
    if (binding.type === 'assets' && (binding.name === 'ASSETS' || binding.name === 'assets')) {
      assetsBindingCount += 1;
      continue;
    }
    if (binding.type === 'plain_text' && typeof binding.name === 'string') {
      const expectedValue = expectedWorkerVars[binding.name as keyof typeof expectedWorkerVars];
      if (
        expectedValue !== undefined &&
        binding.text === expectedValue &&
        !seenVars.has(binding.name)
      ) {
        seenVars.add(binding.name);
        continue;
      }
    }
    return fail('WORKER_BINDINGS_PRESENT');
  }
  if (assetsBindingCount > 1 || (seenVars.size !== 0 && seenVars.size !== 4)) {
    return fail('WORKER_BINDINGS_PRESENT');
  }
  if (requireStagingVars && seenVars.size !== 4) {
    return fail('WORKER_BINDINGS_PRESENT');
  }
}

async function verifyPublicUrlSettings(
  fetcher: NonNullable<StagingSampleDeploymentDependencies['cloudflareFetcher']>,
  token: string,
): Promise<void> {
  const { body } = await getJson(fetcher, workerSubdomainUrl(), token, {
    request: 'CLOUDFLARE_REQUEST_FAILED',
    response: 'CLOUDFLARE_RESPONSE_INVALID',
    api: 'CLOUDFLARE_API_FAILED',
  });
  const result = body.result;
  if (
    !isRecord(result) ||
    typeof result.enabled !== 'boolean' ||
    typeof result.previews_enabled !== 'boolean'
  ) {
    return fail('WORKER_PUBLIC_URL_SETTINGS_INVALID');
  }
  if (!result.enabled) return fail('WORKER_PUBLIC_URL_DISABLED');
  if (result.previews_enabled) return fail('WORKER_PREVIEW_URL_ENABLED');
}

async function readSmokeJson(
  fetcher: NonNullable<StagingSampleDeploymentDependencies['publicFetcher']>,
  url: string,
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail('SMOKE_REQUEST_FAILED');
  }
  if (response.status !== 200) return fail('SMOKE_RESPONSE_INVALID');
  return readJson(response, MAX_SMOKE_RESPONSE_BYTES, 'SMOKE_RESPONSE_INVALID');
}

async function withSmokeRetry<T>(
  operation: () => Promise<T>,
  sleeper: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SMOKE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof StagingSampleDeploymentFailure)) throw error;
      if (attempt + 1 < SMOKE_ATTEMPTS) await sleeper(SMOKE_RETRY_DELAY_MS);
    }
  }
  if (lastError instanceof StagingSampleDeploymentFailure) {
    if (
      lastError.code === 'SMOKE_COMMIT_MISMATCH' ||
      lastError.code === 'SMOKE_HEALTH_INVALID' ||
      lastError.code === 'SMOKE_CONFIG_INVALID' ||
      lastError.code === 'SMOKE_DEPLOYMENT_INVALID'
    ) {
      throw lastError;
    }
  }
  return fail('SMOKE_RETRIES_EXHAUSTED');
}

async function verifyPublicSmoke(
  fetcher: NonNullable<StagingSampleDeploymentDependencies['publicFetcher']>,
  workerUrl: string,
  commit: string,
  sleeper: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const health = await withSmokeRetry(async () => {
    const body = await readSmokeJson(fetcher, `${workerUrl}/api/v1/health`);
    if (body.status !== 'ok') return fail('SMOKE_HEALTH_INVALID');
    return body;
  }, sleeper);
  if (health.status !== 'ok') return fail('SMOKE_HEALTH_INVALID');

  const config = await withSmokeRetry(async () => {
    const body = await readSmokeJson(fetcher, `${workerUrl}/api/v1/config`);
    if (body.dataMode !== 'sample' || body.generationAvailable !== false) {
      return fail('SMOKE_CONFIG_INVALID');
    }
    return body;
  }, sleeper);
  if (config.dataMode !== 'sample' || config.generationAvailable !== false) {
    return fail('SMOKE_CONFIG_INVALID');
  }

  const deployment = await withSmokeRetry(async () => {
    const body = await readSmokeJson(fetcher, `${workerUrl}/__deployment.json`);
    if (
      body.environment !== 'staging' ||
      body.dataMode !== 'sample' ||
      typeof body.commit !== 'string'
    ) {
      return fail('SMOKE_DEPLOYMENT_INVALID');
    }
    if (body.commit.toLowerCase() !== commit) return fail('SMOKE_COMMIT_MISMATCH');
    return body;
  }, sleeper);
  if (deployment.commit !== commit) return fail('SMOKE_COMMIT_MISMATCH');
}

function updateProgress(
  progress: StagingSampleDeploymentProgress,
  changes: Partial<StagingSampleDeploymentProgress>,
  onProgress: StagingSampleDeploymentDependencies['onProgress'],
): void {
  Object.assign(progress, changes);
  onProgress?.({ ...progress });
}

export async function runStagingSampleDeployment(
  context: StagingSampleDeploymentContext,
  dependencies: StagingSampleDeploymentDependencies = {},
): Promise<StagingSampleDeploymentResult> {
  const validated = validateContext(context);
  const progress: StagingSampleDeploymentProgress = {
    environment: 'staging',
    commit: validated.commit,
    url: validated.workerUrl,
    deployment: 'not-run',
    smoke: 'not-run',
  };
  const report = (changes: Partial<StagingSampleDeploymentProgress>) =>
    updateProgress(progress, changes, dependencies.onProgress);

  const githubFetcher = dependencies.githubFetcher ?? fetch;
  const currentDevelopSha = await readDevelopHead(githubFetcher, validated.githubToken);
  if (currentDevelopSha !== validated.commit) {
    report({ deployment: 'skipped' });
    return { ...progress };
  }

  const cloudflareToken = validateCloudflareToken(context.cloudflareApiToken);
  if (!dependencies.prepareArtifact) return fail('ARTIFACT_PREPARATION_FAILED');
  let artifact: { configPath: string };
  try {
    artifact = await dependencies.prepareArtifact(validated.commit);
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_PREPARATION_FAILED');
  }
  if (!artifact || typeof artifact.configPath !== 'string' || artifact.configPath.trim() === '') {
    return fail('ARTIFACT_PREPARATION_FAILED');
  }

  const cloudflareFetcher = dependencies.cloudflareFetcher ?? fetch;
  await readWorkerSettingsAllowMissingAware(cloudflareFetcher, cloudflareToken, false);
  if (!dependencies.deploy) return fail('WRANGLER_RUNNER_MISSING');

  const deployHeadSha = await readDevelopHead(githubFetcher, validated.githubToken);
  if (deployHeadSha !== validated.commit) {
    report({ deployment: 'skipped' });
    return { ...progress };
  }

  report({ deployment: 'attempted' });
  try {
    await dependencies.deploy(artifact.configPath);
  } catch {
    return fail('WRANGLER_DEPLOY_FAILED');
  }
  report({ deployment: 'succeeded' });

  await readWorkerSettingsAllowMissingAware(cloudflareFetcher, cloudflareToken, true);
  await verifyPublicUrlSettings(cloudflareFetcher, cloudflareToken);

  report({ smoke: 'failed' });
  await verifyPublicSmoke(
    dependencies.publicFetcher ?? fetch,
    validated.workerUrl,
    validated.commit,
    dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  );
  report({ smoke: 'passed' });
  return { ...progress };
}

export function renderStagingSampleDeploymentSummary(
  progress: StagingSampleDeploymentProgress,
  errorCode: StagingSampleDeploymentDisplayErrorCode | undefined,
): string {
  const allowedErrorCodes: readonly StagingSampleDeploymentDisplayErrorCode[] = [
    'INPUT_CONTEXT_INVALID',
    'INPUT_SHA_INVALID',
    'INPUT_GITHUB_TOKEN_MISSING',
    'INPUT_GITHUB_TOKEN_INVALID',
    'INPUT_CLOUDFLARE_TOKEN_MISSING',
    'INPUT_CLOUDFLARE_TOKEN_INVALID',
    'INPUT_WORKER_URL_INVALID',
    'GITHUB_REQUEST_FAILED',
    'GITHUB_RESPONSE_INVALID',
    'GITHUB_API_FAILED',
    'ARTIFACT_PREPARATION_FAILED',
    'ARTIFACT_MANIFEST_INVALID',
    'ARTIFACT_CONFIG_PATH_INVALID',
    'ARTIFACT_CONFIG_UNSAFE',
    'ARTIFACT_MARKER_WRITE_FAILED',
    'CLOUDFLARE_REQUEST_FAILED',
    'CLOUDFLARE_RESPONSE_INVALID',
    'CLOUDFLARE_API_FAILED',
    'WORKER_NOT_FOUND',
    'WORKER_BINDINGS_PRESENT',
    'WRANGLER_RUNNER_MISSING',
    'WRANGLER_DEPLOY_FAILED',
    'WORKER_PUBLIC_URL_SETTINGS_INVALID',
    'WORKER_PUBLIC_URL_DISABLED',
    'WORKER_PREVIEW_URL_ENABLED',
    'SMOKE_REQUEST_FAILED',
    'SMOKE_RESPONSE_INVALID',
    'SMOKE_HEALTH_INVALID',
    'SMOKE_CONFIG_INVALID',
    'SMOKE_DEPLOYMENT_INVALID',
    'SMOKE_COMMIT_MISMATCH',
    'SMOKE_RETRIES_EXHAUSTED',
    'INTERNAL_ERROR',
    'SUMMARY_WRITE_FAILED',
  ];
  const safeCommit = /^[0-9a-f]{40}$/i.test(progress.commit)
    ? progress.commit.toLowerCase()
    : 'unknown';
  const safeUrl = progress.url === STAGING_SAMPLE_WORKER_URL ? progress.url : '未設定';
  const safeDeployment = ['not-run', 'skipped', 'attempted', 'succeeded'].includes(
    progress.deployment,
  )
    ? progress.deployment
    : 'not-run';
  const safeSmoke = ['not-run', 'passed', 'failed'].includes(progress.smoke)
    ? progress.smoke
    : 'failed';
  const safeError = errorCode
    ? allowedErrorCodes.includes(errorCode)
      ? errorCode
      : 'INTERNAL_ERROR'
    : undefined;

  return [
    '## Staging sample CD',
    '',
    '- Environment: `staging`',
    `- Commit: \`${safeCommit}\``,
    `- URL: ${safeUrl}`,
    `- Deploy: \`${safeDeployment}\``,
    `- Smoke: \`${safeSmoke}\``,
    '- Cloudflare version ID: 未取得',
    `- Error code: \`${safeError ?? 'none'}\``,
    '',
  ].join('\n');
}
