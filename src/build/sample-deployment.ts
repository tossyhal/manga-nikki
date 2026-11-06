export const SAMPLE_DEPLOYMENT_REPOSITORY = 'tossyhal/manga-nikki';
export const SAMPLE_DEPLOYMENT_ACCOUNT_ID = 'c9cee9599752cb191815c0eea6ff457e';
export const SAMPLE_DEPLOYMENT_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const SAMPLE_DEPLOYMENT_GITHUB_API = 'https://api.github.com';

export type SampleDeploymentEnvironment = 'staging' | 'production';

export type SampleDeploymentProfile<E extends SampleDeploymentEnvironment> = Readonly<{
  environment: E;
  ref: string;
  githubRef: string;
  workerName: string;
  workerUrl: string;
  appEnvironment: E;
  authorizedActorId?: string;
  triggeringActor?: string;
}>;

export const STAGING_SAMPLE_PROFILE: SampleDeploymentProfile<'staging'> = Object.freeze({
  environment: 'staging',
  ref: 'refs/heads/develop',
  githubRef: 'heads/develop',
  workerName: 'manga-nikki-staging',
  workerUrl: 'https://manga-nikki-staging.tossyhal.workers.dev',
  appEnvironment: 'staging',
});

export const PRODUCTION_SAMPLE_PROFILE: SampleDeploymentProfile<'production'> = Object.freeze({
  environment: 'production',
  ref: 'refs/heads/main',
  githubRef: 'heads/main',
  workerName: 'manga-nikki',
  workerUrl: 'https://manga-nikki.tossyhal.workers.dev',
  appEnvironment: 'production',
  authorizedActorId: '92223710',
  triggeringActor: 'tossyhal',
});

export type SampleDeploymentErrorCode =
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

export type SampleDeploymentDisplayErrorCode =
  | SampleDeploymentErrorCode
  | 'INTERNAL_ERROR'
  | 'SUMMARY_WRITE_FAILED';

export class SampleDeploymentFailure extends Error {
  readonly code: SampleDeploymentErrorCode;

  constructor(code: SampleDeploymentErrorCode) {
    super(code);
    this.name = 'SampleDeploymentFailure';
    this.code = code;
  }
}

export type SampleDeploymentContext = {
  githubActions?: string;
  githubRepository?: string;
  githubRef?: string;
  githubEventName?: string;
  githubSha?: string;
  githubActorId?: string;
  githubTriggeringActor?: string;
  githubToken?: string;
  cloudflareApiToken?: string;
  workerUrl?: string;
};

export type SampleDeploymentProgress<E extends SampleDeploymentEnvironment> = {
  environment: E;
  commit: string;
  url: string;
  deployment: 'not-run' | 'skipped' | 'attempted' | 'succeeded';
  smoke: 'not-run' | 'passed' | 'failed';
};

export type SampleDeploymentResult<E extends SampleDeploymentEnvironment> = Readonly<
  SampleDeploymentProgress<E>
>;

export type SampleDeploymentDependencies<E extends SampleDeploymentEnvironment> = {
  githubFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  cloudflareFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  publicFetcher?: (input: string, init: RequestInit) => Promise<Response>;
  prepareArtifact?: (commit: string) => Promise<{ configPath: string }>;
  deploy?: (configPath: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: SampleDeploymentProgress<E>) => void;
};

type JsonRecord = Record<string, unknown>;
type ApiEnvelope = JsonRecord & { success?: unknown; errors?: unknown; result?: unknown };

const MAX_API_RESPONSE_BYTES = 32 * 1024;
const MAX_SMOKE_RESPONSE_BYTES = 16 * 1024;
const SMOKE_ATTEMPTS = 5;
const SMOKE_RETRY_DELAY_MS = 3_000;
function expectedWorkerVars<E extends SampleDeploymentEnvironment>(
  profile: SampleDeploymentProfile<E>,
) {
  return {
    APP_ENV: profile.appEnvironment,
    DATA_MODE: 'sample',
    AI_MODE: 'mock',
    GENERATION_ENABLED: 'false',
  } as const;
}

function fail(code: SampleDeploymentErrorCode): never {
  throw new SampleDeploymentFailure(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSha(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) return fail('INPUT_SHA_INVALID');
  return value.toLowerCase();
}

function validateContext<E extends SampleDeploymentEnvironment>(
  profile: SampleDeploymentProfile<E>,
  context: SampleDeploymentContext,
): {
  commit: string;
  githubToken: string;
  workerUrl: string;
} {
  if (
    context.githubActions !== 'true' ||
    context.githubRepository !== SAMPLE_DEPLOYMENT_REPOSITORY ||
    context.githubRef !== profile.ref ||
    (context.githubEventName !== 'push' && context.githubEventName !== 'workflow_dispatch') ||
    (profile.authorizedActorId !== undefined &&
      context.githubActorId !== profile.authorizedActorId) ||
    (profile.triggeringActor !== undefined &&
      context.githubTriggeringActor !== profile.triggeringActor)
  ) {
    return fail('INPUT_CONTEXT_INVALID');
  }

  const commit = validateSha(context.githubSha);
  const githubToken = context.githubToken;
  if (!githubToken || githubToken.trim() === '') return fail('INPUT_GITHUB_TOKEN_MISSING');
  if (githubToken.trim() !== githubToken || /[\r\n]/.test(githubToken)) {
    return fail('INPUT_GITHUB_TOKEN_INVALID');
  }

  if (context.workerUrl !== profile.workerUrl) return fail('INPUT_WORKER_URL_INVALID');
  return { commit, githubToken, workerUrl: profile.workerUrl };
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
  invalidCode: SampleDeploymentErrorCode,
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
  invalidCode: SampleDeploymentErrorCode,
): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(response, limit, invalidCode));
  } catch (error) {
    if (error instanceof SampleDeploymentFailure) throw error;
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
    request: SampleDeploymentErrorCode;
    response: SampleDeploymentErrorCode;
    api: SampleDeploymentErrorCode;
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

async function readBranchHead(
  profile: SampleDeploymentProfile<SampleDeploymentEnvironment>,
  fetcher: NonNullable<SampleDeploymentDependencies<SampleDeploymentEnvironment>['githubFetcher']>,
  token: string,
): Promise<string> {
  const url = `${SAMPLE_DEPLOYMENT_GITHUB_API}/repos/${SAMPLE_DEPLOYMENT_REPOSITORY}/git/ref/${profile.githubRef}`;
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

function workerSettingsUrl(profile: SampleDeploymentProfile<SampleDeploymentEnvironment>): string {
  return `${SAMPLE_DEPLOYMENT_CLOUDFLARE_API}/accounts/${SAMPLE_DEPLOYMENT_ACCOUNT_ID}/workers/scripts/${profile.workerName}/settings`;
}

function workerSubdomainUrl(profile: SampleDeploymentProfile<SampleDeploymentEnvironment>): string {
  return `${SAMPLE_DEPLOYMENT_CLOUDFLARE_API}/accounts/${SAMPLE_DEPLOYMENT_ACCOUNT_ID}/workers/scripts/${profile.workerName}/subdomain`;
}

async function readWorkerSettingsAllowMissingAware(
  profile: SampleDeploymentProfile<SampleDeploymentEnvironment>,
  fetcher: NonNullable<
    SampleDeploymentDependencies<SampleDeploymentEnvironment>['cloudflareFetcher']
  >,
  token: string,
  requireSampleVars: boolean,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(workerSettingsUrl(profile), {
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
      const expectedVars = expectedWorkerVars(profile);
      const expectedValue = expectedVars[binding.name as keyof typeof expectedVars];
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
  if (requireSampleVars && seenVars.size !== 4) {
    return fail('WORKER_BINDINGS_PRESENT');
  }
}

async function verifyPublicUrlSettings(
  profile: SampleDeploymentProfile<SampleDeploymentEnvironment>,
  fetcher: NonNullable<
    SampleDeploymentDependencies<SampleDeploymentEnvironment>['cloudflareFetcher']
  >,
  token: string,
): Promise<void> {
  const { body } = await getJson(fetcher, workerSubdomainUrl(profile), token, {
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
  fetcher: NonNullable<SampleDeploymentDependencies<SampleDeploymentEnvironment>['publicFetcher']>,
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
      if (!(error instanceof SampleDeploymentFailure)) throw error;
      if (attempt + 1 < SMOKE_ATTEMPTS) await sleeper(SMOKE_RETRY_DELAY_MS);
    }
  }
  if (lastError instanceof SampleDeploymentFailure) {
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
  profile: SampleDeploymentProfile<SampleDeploymentEnvironment>,
  fetcher: NonNullable<SampleDeploymentDependencies<SampleDeploymentEnvironment>['publicFetcher']>,
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
      body.environment !== profile.environment ||
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
  progress: SampleDeploymentProgress<SampleDeploymentEnvironment>,
  changes: Partial<SampleDeploymentProgress<SampleDeploymentEnvironment>>,
  onProgress:
    | ((progress: SampleDeploymentProgress<SampleDeploymentEnvironment>) => void)
    | undefined,
): void {
  Object.assign(progress, changes);
  onProgress?.({ ...progress });
}

export async function runSampleDeployment<E extends SampleDeploymentEnvironment>(
  profile: SampleDeploymentProfile<E>,
  context: SampleDeploymentContext,
  dependencies: SampleDeploymentDependencies<E> = {},
): Promise<SampleDeploymentResult<E>> {
  const validated = validateContext(profile, context);
  const progress: SampleDeploymentProgress<SampleDeploymentEnvironment> = {
    environment: profile.environment,
    commit: validated.commit,
    url: validated.workerUrl,
    deployment: 'not-run',
    smoke: 'not-run',
  };
  const report = (changes: Partial<SampleDeploymentProgress<E>>) =>
    updateProgress(
      progress,
      changes,
      dependencies.onProgress as
        | ((progress: SampleDeploymentProgress<SampleDeploymentEnvironment>) => void)
        | undefined,
    );

  const githubFetcher = dependencies.githubFetcher ?? fetch;
  const currentBranchSha = await readBranchHead(profile, githubFetcher, validated.githubToken);
  if (currentBranchSha !== validated.commit) {
    report({ deployment: 'skipped' });
    return { ...progress } as SampleDeploymentResult<E>;
  }

  const cloudflareToken = validateCloudflareToken(context.cloudflareApiToken);
  if (!dependencies.prepareArtifact) return fail('ARTIFACT_PREPARATION_FAILED');
  let artifact: { configPath: string };
  try {
    artifact = await dependencies.prepareArtifact(validated.commit);
  } catch (error) {
    if (error instanceof SampleDeploymentFailure) throw error;
    return fail('ARTIFACT_PREPARATION_FAILED');
  }
  if (!artifact || typeof artifact.configPath !== 'string' || artifact.configPath.trim() === '') {
    return fail('ARTIFACT_PREPARATION_FAILED');
  }

  const cloudflareFetcher = dependencies.cloudflareFetcher ?? fetch;
  await readWorkerSettingsAllowMissingAware(profile, cloudflareFetcher, cloudflareToken, false);
  if (!dependencies.deploy) return fail('WRANGLER_RUNNER_MISSING');

  const deployHeadSha = await readBranchHead(profile, githubFetcher, validated.githubToken);
  if (deployHeadSha !== validated.commit) {
    report({ deployment: 'skipped' });
    return { ...progress } as SampleDeploymentResult<E>;
  }

  report({ deployment: 'attempted' });
  try {
    await dependencies.deploy(artifact.configPath);
  } catch {
    return fail('WRANGLER_DEPLOY_FAILED');
  }
  report({ deployment: 'succeeded' });

  await readWorkerSettingsAllowMissingAware(profile, cloudflareFetcher, cloudflareToken, true);
  await verifyPublicUrlSettings(profile, cloudflareFetcher, cloudflareToken);

  report({ smoke: 'failed' });
  await verifyPublicSmoke(
    profile,
    dependencies.publicFetcher ?? fetch,
    validated.workerUrl,
    validated.commit,
    dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  );
  report({ smoke: 'passed' });
  return { ...progress } as SampleDeploymentResult<E>;
}

export function renderSampleDeploymentSummary<E extends SampleDeploymentEnvironment>(
  profile: SampleDeploymentProfile<E>,
  progress: SampleDeploymentProgress<E>,
  errorCode: SampleDeploymentDisplayErrorCode | undefined,
): string {
  const allowedErrorCodes: readonly SampleDeploymentDisplayErrorCode[] = [
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
  const safeUrl = progress.url === profile.workerUrl ? progress.url : '未設定';
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
    `## ${profile.environment === 'production' ? 'Production' : 'Staging'} sample CD`,
    '',
    `- Environment: \`${profile.environment}\``,
    `- Commit: \`${safeCommit}\``,
    `- URL: ${safeUrl}`,
    `- Deploy: \`${safeDeployment}\``,
    `- Skip reason: ${safeDeployment === 'skipped' ? '実行SHAと現在branch HEADが一致しません' : 'なし'}`,
    `- Smoke: \`${safeSmoke}\``,
    '- Cloudflare version ID: 未取得',
    `- Error code: \`${safeError ?? 'none'}\``,
    '',
  ].join('\n');
}
