import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  STAGING_SAMPLE_ACCOUNT_ID,
  STAGING_SAMPLE_WORKER_NAME,
  StagingSampleDeploymentFailure,
} from './staging-sample-deployment.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const wranglerCli = join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export type WranglerExecutionOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
};

export type WranglerExecutor = (
  file: string,
  args: string[],
  options: WranglerExecutionOptions,
) => Promise<unknown>;

export type WranglerStagingSampleDependencies = {
  executor?: WranglerExecutor;
};

const expectedVars = {
  APP_ENV: 'staging',
  DATA_MODE: 'sample',
  AI_MODE: 'mock',
  GENERATION_ENABLED: 'false',
} as const;

const emptyArrayBindingKeys = [
  'workflows',
  'migrations',
  'containers',
  'kv_namespaces',
  'send_email',
  'connect',
  'r2_buckets',
  'd1_databases',
  'vectorize',
  'ai_search_namespaces',
  'ai_search',
  'agent_memory',
  'hyperdrive',
  'services',
  'analytics_engine_datasets',
  'dispatch_namespaces',
  'mtls_certificates',
  'pipelines',
  'k2',
  'secrets_store_secrets',
  'artifacts',
  'unsafe_hello_world',
  'flagship',
  'worker_loaders',
  'ratelimits',
  'vpc_services',
  'vpc_networks',
  'tail_consumers',
  'streaming_tail_consumers',
] as const;
const emptyOptionalBindingKeys = [
  'ai',
  'analytics',
  'browser',
  'images',
  'media',
  'stream',
  'version_metadata',
  'unsafe',
  'site',
  'wasm_modules',
  'alias',
  'define',
  'dependencies_instrumentation',
  'text_blobs',
  'data_blobs',
  'routes',
] as const;
const allowedGeneratedConfigKeys = new Set([
  'configPath',
  'userConfigPath',
  'topLevelName',
  'definedEnvironments',
  'targetEnvironment',
  'compatibility_date',
  'compatibility_flags',
  'jsx_factory',
  'jsx_fragment',
  'rules',
  'name',
  'main',
  'account_id',
  'workers_dev',
  'preview_urls',
  'routes',
  'triggers',
  'assets',
  'vars',
  'secrets',
  'durable_objects',
  'workflows',
  'migrations',
  'exports',
  'kv_namespaces',
  'cloudchamber',
  'send_email',
  'queues',
  'connect',
  'r2_buckets',
  'd1_databases',
  'vectorize',
  'ai_search_namespaces',
  'ai_search',
  'agent_memory',
  'hyperdrive',
  'services',
  'analytics_engine_datasets',
  'dispatch_namespaces',
  'mtls_certificates',
  'pipelines',
  'k2',
  'secrets_store_secrets',
  'artifacts',
  'unsafe_hello_world',
  'flagship',
  'worker_loaders',
  'ratelimits',
  'vpc_services',
  'vpc_networks',
  'logfwdr',
  'upload_source_maps',
  'observability',
  'python_modules',
  'dev',
  'no_bundle',
]);

function fail(
  code:
    | 'ARTIFACT_MANIFEST_INVALID'
    | 'ARTIFACT_CONFIG_PATH_INVALID'
    | 'ARTIFACT_CONFIG_UNSAFE'
    | 'ARTIFACT_MARKER_WRITE_FAILED',
): never {
  throw new StagingSampleDeploymentFailure(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWithin(parent: string, child: string): void {
  const relativePath = relative(parent, child);
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  ) {
    fail('ARTIFACT_CONFIG_PATH_INVALID');
  }
}

function assertEmptyArray(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
}

function assertAbsentOrEmpty(value: unknown): void {
  if (
    value !== undefined &&
    !(
      (Array.isArray(value) && value.length === 0) ||
      (isRecord(value) && Object.keys(value).length === 0)
    )
  ) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
}

function assertNoBindings(config: Record<string, unknown>): void {
  if ([...Object.keys(config)].some((key) => !allowedGeneratedConfigKeys.has(key))) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
  for (const key of emptyArrayBindingKeys) assertEmptyArray(config[key]);
  for (const key of emptyOptionalBindingKeys) assertAbsentOrEmpty(config[key]);

  const queues = config.queues;
  if (queues !== undefined) {
    if (!isRecord(queues)) fail('ARTIFACT_CONFIG_UNSAFE');
    assertEmptyArray(queues.producers);
    assertEmptyArray(queues.consumers);
  }

  const secrets = config.secrets;
  if (secrets !== undefined) {
    if (!isRecord(secrets)) fail('ARTIFACT_CONFIG_UNSAFE');
    assertEmptyArray(secrets.required);
  }

  const durableObjects = config.durable_objects;
  if (durableObjects !== undefined) {
    if (!isRecord(durableObjects)) fail('ARTIFACT_CONFIG_UNSAFE');
    assertEmptyArray(durableObjects.bindings);
  }

  const logForwarding = config.logfwdr;
  if (logForwarding !== undefined) {
    if (!isRecord(logForwarding)) fail('ARTIFACT_CONFIG_UNSAFE');
    assertEmptyArray(logForwarding.bindings);
  }

  const exports = config.exports;
  if (exports !== undefined && (!isRecord(exports) || Object.keys(exports).length !== 0)) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }

  if (config.bindings !== undefined) assertEmptyArray(config.bindings);
  if (config.route !== undefined) fail('ARTIFACT_CONFIG_UNSAFE');
  if (config.access !== undefined) fail('ARTIFACT_CONFIG_UNSAFE');
  if (config.keep_vars !== undefined && config.keep_vars !== false) fail('ARTIFACT_CONFIG_UNSAFE');
  const cloudchamber = config.cloudchamber;
  if (cloudchamber !== undefined) assertAbsentOrEmpty(cloudchamber);
}

function assertExpectedConfiguration(config: Record<string, unknown>): void {
  if (
    config.name !== STAGING_SAMPLE_WORKER_NAME ||
    config.targetEnvironment !== 'staging' ||
    config.workers_dev !== true ||
    config.preview_urls !== false
  ) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
  if (config.account_id !== undefined && config.account_id !== STAGING_SAMPLE_ACCOUNT_ID) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
  if (typeof config.main !== 'string' || config.main.trim() === '') {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }

  const vars = config.vars;
  if (
    !isRecord(vars) ||
    Object.keys(vars).length !== Object.keys(expectedVars).length ||
    !Object.entries(expectedVars).every(([key, value]) => vars[key] === value)
  ) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }

  const triggers = config.triggers;
  if (!isRecord(triggers) || !Array.isArray(triggers.crons) || triggers.crons.length !== 0) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }

  const assets = config.assets;
  if (!isRecord(assets) || typeof assets.directory !== 'string' || assets.directory.trim() === '') {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
  const routes = config.routes;
  if (routes !== undefined && (!Array.isArray(routes) || routes.length !== 0)) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }

  assertNoBindings(config);
  if (!isRecord(config.observability) || config.observability.enabled !== false) {
    fail('ARTIFACT_CONFIG_UNSAFE');
  }
}

async function assertNoDevVars(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail('ARTIFACT_CONFIG_PATH_INVALID');
  }
  for (const entry of entries) {
    if (entry.name === '.dev.vars') fail('ARTIFACT_CONFIG_UNSAFE');
    if (entry.isSymbolicLink()) fail('ARTIFACT_CONFIG_UNSAFE');
    if (entry.isDirectory()) await assertNoDevVars(join(directory, entry.name));
    else if (!entry.isFile()) fail('ARTIFACT_CONFIG_UNSAFE');
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fail('ARTIFACT_MANIFEST_INVALID');
  }
  if (!isRecord(parsed)) return fail('ARTIFACT_MANIFEST_INVALID');
  return parsed;
}

export async function prepareStagingReleaseArtifact(
  commit: string,
  projectRoot = repositoryRoot,
): Promise<{ configPath: string }> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new StagingSampleDeploymentFailure('INPUT_SHA_INVALID');
  }
  const manifestPath = join(projectRoot, '.wrangler', 'deploy', 'config.json');
  const distPath = join(projectRoot, 'dist');
  let rootRealPath: string;
  let manifestRealPath: string;
  let distRealPath: string;
  try {
    rootRealPath = await realpath(projectRoot);
    manifestRealPath = await realpath(manifestPath);
    distRealPath = await realpath(distPath);
    assertWithin(rootRealPath, manifestRealPath);
    assertWithin(rootRealPath, distRealPath);
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_MANIFEST_INVALID');
  }

  const manifest = await readJsonFile(manifestRealPath);
  if (typeof manifest.configPath !== 'string' || manifest.configPath.trim() === '') {
    return fail('ARTIFACT_MANIFEST_INVALID');
  }
  if (isAbsolute(manifest.configPath)) return fail('ARTIFACT_CONFIG_PATH_INVALID');

  let configPathReal: string;
  try {
    configPathReal = await realpath(resolve(dirname(manifestRealPath), manifest.configPath));
    assertWithin(distRealPath, configPathReal);
    const configStats = await stat(configPathReal);
    if (!configStats.isFile()) fail('ARTIFACT_CONFIG_PATH_INVALID');
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_CONFIG_PATH_INVALID');
  }

  const config = await readJsonFile(configPathReal);
  assertExpectedConfiguration(config);

  if (typeof config.main !== 'string') return fail('ARTIFACT_CONFIG_UNSAFE');
  try {
    const mainRealPath = await realpath(resolve(dirname(configPathReal), config.main));
    assertWithin(distRealPath, mainRealPath);
    if (!(await stat(mainRealPath)).isFile()) fail('ARTIFACT_CONFIG_UNSAFE');
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_CONFIG_UNSAFE');
  }

  const assets = config.assets;
  if (!isRecord(assets) || typeof assets.directory !== 'string') {
    return fail('ARTIFACT_CONFIG_UNSAFE');
  }
  const clientPath = join(distPath, 'client');
  let clientRealPath: string;
  try {
    clientRealPath = await realpath(clientPath);
    assertWithin(distRealPath, clientRealPath);
    if (!(await stat(clientRealPath)).isDirectory()) fail('ARTIFACT_CONFIG_UNSAFE');
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_CONFIG_UNSAFE');
  }
  try {
    const assetRootReal = await realpath(resolve(dirname(configPathReal), assets.directory));
    assertWithin(distRealPath, assetRootReal);
    const assetStats = await stat(assetRootReal);
    if (!assetStats.isDirectory() || assetRootReal !== clientRealPath) {
      fail('ARTIFACT_CONFIG_UNSAFE');
    }
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_CONFIG_UNSAFE');
  }

  await assertNoDevVars(distRealPath);

  const markerPath = join(clientRealPath, '__deployment.json');
  try {
    try {
      const existing = await lstat(markerPath);
      if (existing.isSymbolicLink() || !existing.isFile()) fail('ARTIFACT_CONFIG_UNSAFE');
    } catch (error) {
      if (error instanceof StagingSampleDeploymentFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(
      markerPath,
      `${JSON.stringify({ environment: 'staging', commit, dataMode: 'sample' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof StagingSampleDeploymentFailure) throw error;
    return fail('ARTIFACT_MARKER_WRITE_FAILED');
  }

  return { configPath: configPathReal };
}

async function executeWrangler(
  file: string,
  args: string[],
  options: WranglerExecutionOptions,
): Promise<void> {
  await execFileAsync(file, args, options);
}

export async function runWranglerStagingSampleDeploy(
  configPath: string,
  dependencies: WranglerStagingSampleDependencies = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'CI'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
  if (cloudflareToken !== undefined) env.CLOUDFLARE_API_TOKEN = cloudflareToken;
  env.CLOUDFLARE_ACCOUNT_ID = STAGING_SAMPLE_ACCOUNT_ID;
  env.WRANGLER_SEND_METRICS = 'false';

  try {
    await (dependencies.executor ?? executeWrangler)(
      process.execPath,
      [wranglerCli, 'deploy', '--config', configPath],
      {
        cwd: repositoryRoot,
        env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    throw new StagingSampleDeploymentFailure('WRANGLER_DEPLOY_FAILED');
  }
}
