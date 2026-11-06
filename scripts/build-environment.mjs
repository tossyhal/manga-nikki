import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const releaseTargets = new Set(['staging', 'production', 'demo']);
const publicVariables = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY',
]);
const target = process.argv[2];

assert(releaseTargets.has(target), '対象はstaging、productionまたはdemoを指定してください。');

function saveEnvironment(keys) {
  return new Map([...keys].map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadPublicVariables() {
  const envFile = path.join(projectRoot, `.env.${target}.local`);
  let contents;
  try {
    contents = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  const parsed = parseEnv(contents);
  const unsupported = Object.keys(parsed).filter((key) => !publicVariables.has(key));
  assert(
    unsupported.length === 0,
    `${path.basename(envFile)}には公開設定の3変数だけを記載してください: ${unsupported.join(', ')}`,
  );
  return parsed;
}

async function removePreviewSecrets(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await removePreviewSecrets(entryPath);
    else if (entry.isFile() && entry.name === '.dev.vars') await unlink(entryPath);
  }
}

const environmentKeys = new Set([
  ...publicVariables,
  ...Object.keys(process.env).filter(
    (key) =>
      key.startsWith('VITE_') ||
      key.startsWith('CLOUDFLARE_') ||
      key.startsWith('WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_'),
  ),
  'NODE_ENV',
  'CLOUDFLARE_ENV',
  'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
  'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV',
  'CLOUDFLARE_INCLUDE_PROCESS_ENV',
  'MANGA_NIKKI_RELEASE_TARGET',
]);
const previousEnvironment = saveEnvironment(environmentKeys);
let buildAttempted = false;

try {
  for (const key of environmentKeys) delete process.env[key];

  const publicValues = await loadPublicVariables();
  if (target === 'demo' || target === 'production') {
    const missing = [...publicVariables].filter((key) => !publicValues[key]?.trim());
    assert(
      missing.length === 0,
      `.env.${target}.localに公開設定の3変数を設定してください: ${missing.join(', ')}`,
    );
  }
  Object.assign(process.env, publicValues);
  process.env.NODE_ENV = 'production';
  process.env.CLOUDFLARE_ENV = target;
  process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = path.join(projectRoot, 'wrangler.jsonc');
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  process.env.MANGA_NIKKI_RELEASE_TARGET = target;

  const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  buildAttempted = true;
  let result;
  try {
    result = await execFileAsync(process.execPath, [viteCli, 'build', '--mode', target], {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.stdout === 'string') process.stdout.write(error.stdout);
    if (typeof error.stderr === 'string') process.stderr.write(error.stderr);
    throw error;
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  await removePreviewSecrets(path.join(projectRoot, 'dist'));
  await import('./check-pwa-build.mjs');
  await import('./check-release-build.mjs');
  console.log(`Release build artifact checks passed for ${target}.`);
} finally {
  try {
    if (buildAttempted) await removePreviewSecrets(path.join(projectRoot, 'dist'));
  } finally {
    restoreEnvironment(previousEnvironment);
  }
}
