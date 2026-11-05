export const STAGING_ACCOUNT_ID = 'c9cee9599752cb191815c0eea6ff457e';
export const STAGING_WORKER_NAME = 'manga-nikki-staging';
export const STAGING_COMPATIBILITY_DATE = '2026-10-26';
export const STAGING_CONFIRMATION = 'manga-nikki-staging';
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export const STAGING_WORKER_SOURCE = `export default {
  fetch() {
    return new Response(JSON.stringify({ error: 'staging_worker_not_implemented' }), {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
`;

export const STAGING_WRANGLER_CONFIG = `${JSON.stringify(
  {
    name: STAGING_WORKER_NAME,
    account_id: STAGING_ACCOUNT_ID,
    main: 'worker.mjs',
    compatibility_date: STAGING_COMPATIBILITY_DATE,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    triggers: { crons: [] },
  },
  null,
  2,
)}\n`;

export type BootstrapOperation = 'check' | 'create';

export type BootstrapErrorCode =
  | 'INPUT_OPERATION_INVALID'
  | 'INPUT_CONTEXT_INVALID'
  | 'INPUT_CONFIRMATION_INVALID'
  | 'INPUT_EXCLUSIVE_SETUP_REQUIRED'
  | 'CLOUDFLARE_TOKEN_MISSING'
  | 'CLOUDFLARE_TOKEN_INVALID'
  | 'CLOUDFLARE_REQUEST_FAILED'
  | 'CLOUDFLARE_RESPONSE_INVALID'
  | 'CLOUDFLARE_API_FAILED'
  | 'WORKER_ALREADY_EXISTS'
  | 'WORKER_MISSING_AFTER_DEPLOY'
  | 'WORKER_PUBLIC_URL_ENABLED'
  | 'DEPLOY_RUNNER_MISSING'
  | 'DEPLOY_FAILED';

export type BootstrapDisplayErrorCode =
  | BootstrapErrorCode
  | 'INTERNAL_ERROR'
  | 'SUMMARY_WRITE_FAILED';

export class BootstrapFailure extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode) {
    super(code);
    this.name = 'BootstrapFailure';
    this.code = code;
  }
}

export type BootstrapContext = {
  githubActions?: string;
  githubRepository?: string;
  githubRef?: string;
  operation?: string;
  confirmation?: string;
  exclusiveSetup?: string;
  cloudflareApiToken?: string;
};

export type BootstrapProgress = {
  operation: BootstrapOperation | 'unknown';
  existence: 'unknown' | 'missing' | 'present';
  creation: 'not-requested' | 'attempted' | 'completed';
  publicUrlCheck: 'not-run' | 'not-applicable' | 'passed' | 'failed';
};

export type DeploymentPlan = {
  workerSource: string;
  wranglerConfig: string;
};

export type BootstrapResult = Readonly<BootstrapProgress>;

export type BootstrapDependencies = {
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  deploy?: (plan: DeploymentPlan) => Promise<void>;
  onProgress?: (progress: BootstrapProgress) => void;
};

export function renderBootstrapSummary(
  progress: BootstrapProgress,
  commit: string | undefined,
  errorCode: BootstrapDisplayErrorCode | undefined,
): string {
  const safeOperation =
    progress.operation === 'check' || progress.operation === 'create'
      ? progress.operation
      : 'unknown';
  const safeCommit = commit && /^[0-9a-f]{40}$/i.test(commit) ? commit : 'unknown';
  const errorCodes: readonly BootstrapDisplayErrorCode[] = [
    'INPUT_OPERATION_INVALID',
    'INPUT_CONTEXT_INVALID',
    'INPUT_CONFIRMATION_INVALID',
    'INPUT_EXCLUSIVE_SETUP_REQUIRED',
    'CLOUDFLARE_TOKEN_MISSING',
    'CLOUDFLARE_TOKEN_INVALID',
    'CLOUDFLARE_REQUEST_FAILED',
    'CLOUDFLARE_RESPONSE_INVALID',
    'CLOUDFLARE_API_FAILED',
    'WORKER_ALREADY_EXISTS',
    'WORKER_MISSING_AFTER_DEPLOY',
    'WORKER_PUBLIC_URL_ENABLED',
    'DEPLOY_RUNNER_MISSING',
    'DEPLOY_FAILED',
    'INTERNAL_ERROR',
    'SUMMARY_WRITE_FAILED',
  ];
  const safeErrorCode = errorCode && errorCodes.includes(errorCode) ? errorCode : undefined;
  const result = safeErrorCode ? `失敗（${safeErrorCode}）` : '成功';
  const creation = {
    'not-requested': '未実行',
    attempted: '実行開始（結果未確認）',
    completed: '完了',
  }[progress.creation];
  const publicUrlCheck = {
    'not-run': '未確認',
    'not-applicable': 'Worker未作成のため対象外',
    passed: 'workers.devとPreview URLが無効であることを確認',
    failed: '無効状態を確認できませんでした',
  }[progress.publicUrlCheck];

  return [
    '## Staging Worker初期作成',
    '',
    `- Account ID: \`${STAGING_ACCOUNT_ID}\``,
    `- Worker: \`${STAGING_WORKER_NAME}\``,
    `- Commit: \`${safeCommit}\``,
    `- Operation: \`${safeOperation}\``,
    `- 結果: ${result}`,
    `- Worker存在: \`${progress.existence}\``,
    `- 作成: ${creation}`,
    `- 公開URL確認: ${publicUrlCheck}`,
    '- route/custom domainはこの処理では作成しません。既存routeやcustom domainの全体監査は含みません。',
    '',
  ].join('\n');
}

type CloudflareEnvelope = {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
};

function fail(code: BootstrapErrorCode): never {
  throw new BootstrapFailure(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCodes(envelope: CloudflareEnvelope): number[] {
  if (!Array.isArray(envelope.errors)) return [];
  return envelope.errors.flatMap((error) =>
    isRecord(error) && typeof error.code === 'number' ? [error.code] : [],
  );
}

function selectedOperation(value: string | undefined): BootstrapOperation {
  if (value === undefined || value === '') return 'check';
  if (value === 'check' || value === 'create') return value;
  return fail('INPUT_OPERATION_INVALID');
}

function validateContext(context: BootstrapContext): {
  operation: BootstrapOperation;
  token: string;
} {
  const operation = selectedOperation(context.operation);
  if (
    context.githubActions !== 'true' ||
    context.githubRepository !== 'tossyhal/manga-nikki' ||
    context.githubRef !== 'refs/heads/main'
  ) {
    return fail('INPUT_CONTEXT_INVALID');
  }
  if (operation === 'create' && context.confirmation !== STAGING_CONFIRMATION) {
    return fail('INPUT_CONFIRMATION_INVALID');
  }
  if (operation === 'create' && context.exclusiveSetup !== 'true') {
    return fail('INPUT_EXCLUSIVE_SETUP_REQUIRED');
  }
  const token = context.cloudflareApiToken;
  if (!token || token.trim() === '') return fail('CLOUDFLARE_TOKEN_MISSING');
  if (token.trim() !== token) return fail('CLOUDFLARE_TOKEN_INVALID');
  return { operation, token };
}

async function cloudflareGet(
  fetcher: NonNullable<BootstrapDependencies['fetcher']>,
  token: string,
  path: string,
): Promise<{ response: Response; envelope: CloudflareEnvelope }> {
  let response: Response;
  try {
    response = await fetcher(`${CLOUDFLARE_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail('CLOUDFLARE_REQUEST_FAILED');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return fail('CLOUDFLARE_RESPONSE_INVALID');
  }
  if (!isRecord(parsed)) return fail('CLOUDFLARE_RESPONSE_INVALID');
  return { response, envelope: parsed };
}

async function readWorkerExistence(
  fetcher: NonNullable<BootstrapDependencies['fetcher']>,
  token: string,
): Promise<'missing' | 'present'> {
  const { response, envelope } = await cloudflareGet(
    fetcher,
    token,
    `/accounts/${STAGING_ACCOUNT_ID}/workers/scripts/${STAGING_WORKER_NAME}/settings`,
  );

  if (
    response.status === 404 &&
    envelope.success === false &&
    errorCodes(envelope).includes(10007)
  ) {
    return 'missing';
  }
  if (!response.ok || envelope.success !== true || !isRecord(envelope.result)) {
    return fail('CLOUDFLARE_API_FAILED');
  }
  return 'present';
}

async function readPublicUrlSettings(
  fetcher: NonNullable<BootstrapDependencies['fetcher']>,
  token: string,
): Promise<{ enabled: boolean; previewsEnabled: boolean }> {
  const { response, envelope } = await cloudflareGet(
    fetcher,
    token,
    `/accounts/${STAGING_ACCOUNT_ID}/workers/scripts/${STAGING_WORKER_NAME}/subdomain`,
  );
  if (!response.ok || envelope.success !== true || !isRecord(envelope.result)) {
    return fail('CLOUDFLARE_API_FAILED');
  }
  const { enabled, previews_enabled: previewsEnabled } = envelope.result;
  if (typeof enabled !== 'boolean' || typeof previewsEnabled !== 'boolean') {
    return fail('CLOUDFLARE_RESPONSE_INVALID');
  }
  return { enabled, previewsEnabled };
}

function updateProgress(
  progress: BootstrapProgress,
  changes: Partial<BootstrapProgress>,
  onProgress: BootstrapDependencies['onProgress'],
): void {
  Object.assign(progress, changes);
  onProgress?.({ ...progress });
}

export async function runDeploymentBootstrap(
  context: BootstrapContext,
  dependencies: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const progress: BootstrapProgress = {
    operation: 'unknown',
    existence: 'unknown',
    creation: 'not-requested',
    publicUrlCheck: 'not-run',
  };
  const validated = validateContext(context);
  updateProgress(progress, { operation: validated.operation }, dependencies.onProgress);

  const existence = await readWorkerExistence(fetcher, validated.token);
  updateProgress(progress, { existence }, dependencies.onProgress);

  if (existence === 'present') {
    if (validated.operation === 'create') return fail('WORKER_ALREADY_EXISTS');
    const publicUrlSettings = await readPublicUrlSettings(fetcher, validated.token);
    const publicUrlDisabled = !publicUrlSettings.enabled && !publicUrlSettings.previewsEnabled;
    updateProgress(
      progress,
      { publicUrlCheck: publicUrlDisabled ? 'passed' : 'failed' },
      dependencies.onProgress,
    );
    if (!publicUrlDisabled) return fail('WORKER_PUBLIC_URL_ENABLED');
    return { ...progress };
  }

  if (validated.operation === 'check') {
    updateProgress(progress, { publicUrlCheck: 'not-applicable' }, dependencies.onProgress);
    return { ...progress };
  }

  if (!dependencies.deploy) return fail('DEPLOY_RUNNER_MISSING');
  updateProgress(
    progress,
    { existence: 'unknown', creation: 'attempted' },
    dependencies.onProgress,
  );
  try {
    await dependencies.deploy({
      workerSource: STAGING_WORKER_SOURCE,
      wranglerConfig: STAGING_WRANGLER_CONFIG,
    });
  } catch {
    return fail('DEPLOY_FAILED');
  }
  updateProgress(progress, { creation: 'completed' }, dependencies.onProgress);

  const afterDeploy = await readWorkerExistence(fetcher, validated.token);
  updateProgress(progress, { existence: afterDeploy }, dependencies.onProgress);
  if (afterDeploy !== 'present') return fail('WORKER_MISSING_AFTER_DEPLOY');

  const publicUrlSettings = await readPublicUrlSettings(fetcher, validated.token);
  const publicUrlDisabled = !publicUrlSettings.enabled && !publicUrlSettings.previewsEnabled;
  updateProgress(
    progress,
    { publicUrlCheck: publicUrlDisabled ? 'passed' : 'failed' },
    dependencies.onProgress,
  );
  if (!publicUrlDisabled) return fail('WORKER_PUBLIC_URL_ENABLED');
  return { ...progress };
}
