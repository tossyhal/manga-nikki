import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'manga-nikki-release-fixture-'));
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.vite',
]);
const allowedEnvExamples = new Set([
  '.env.example',
  '.env.staging.example',
  '.env.production.example',
  '.dev.vars.example',
]);

function shouldCopy(sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  if (!relativePath) return true;
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => excludedDirectories.has(segment))) return false;

  const filename = path.basename(sourcePath);
  if (filename.startsWith('.env') && !allowedEnvExamples.has(filename)) return false;
  if (filename.startsWith('.dev.vars') && !allowedEnvExamples.has(filename)) return false;
  return true;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

try {
  await cp(projectRoot, fixtureRoot, { recursive: true, filter: shouldCopy });
  await symlink(
    path.join(projectRoot, 'node_modules'),
    path.join(fixtureRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await writeFile(
    path.join(fixtureRoot, '.env.local'),
    [
      'VITE_SUPABASE_URL=https://local-env-sentinel.invalid',
      'VITE_SUPABASE_PUBLISHABLE_KEY=local-env-publishable-sentinel',
      'VITE_TURNSTILE_SITE_KEY=local-env-sitekey-sentinel',
      'VITE_UNAPPROVED_LOCAL_SENTINEL=should-be-ignored',
    ].join('\n'),
  );
  await writeFile(
    path.join(fixtureRoot, '.env.development.local'),
    'VITE_SUPABASE_URL=development-local-sentinel.invalid\n',
  );
  await writeFile(
    path.join(fixtureRoot, '.env.staging.local'),
    [
      'VITE_SUPABASE_URL=https://staging-public-sentinel.invalid',
      'VITE_SUPABASE_PUBLISHABLE_KEY=staging-publishable-sentinel',
      'VITE_TURNSTILE_SITE_KEY=staging-sitekey-sentinel',
    ].join('\n'),
  );
  await writeFile(
    path.join(fixtureRoot, '.env.production.local'),
    'VITE_SUPABASE_URL=wrong-production-target-sentinel.invalid\n',
  );
  await writeFile(
    path.join(fixtureRoot, '.dev.vars'),
    [
      'APP_ENV="development"',
      'DATA_MODE="mock"',
      'AI_MODE="mock"',
      'GENERATION_ENABLED="true"',
      'SUPABASE_SECRET_KEY="worker-secret-sentinel"',
      'TURNSTILE_SECRET_KEY="turnstile-secret-sentinel"',
      'GEMINI_API_KEY="ai-secret-sentinel"',
    ].join('\n'),
  );

  const childEnvironment = {
    ...process.env,
    CLOUDFLARE_ENV: 'production',
    VITE_SUPABASE_URL: 'process-env-supabase-sentinel.invalid',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'process-env-publishable-sentinel',
    VITE_TURNSTILE_SITE_KEY: 'process-env-sitekey-sentinel',
    VITE_UNAPPROVED_PROCESS_SENTINEL: 'should-be-ignored',
    SUPABASE_SECRET_KEY: 'process-env-server-secret-sentinel',
    TURNSTILE_SECRET_KEY: 'process-env-turnstile-secret-sentinel',
    GEMINI_API_KEY: 'process-env-ai-secret-sentinel',
  };

  try {
    await execFileAsync(process.execPath, ['scripts/build-environment.mjs', 'staging'], {
      cwd: fixtureRoot,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`隔離fixtureのstaging buildが失敗しました。${details ? `\n${details}` : ''}`);
  }

  const artifactFiles = await collectFiles(path.join(fixtureRoot, 'dist'));
  const artifactContents = await Promise.all(artifactFiles.map((file) => readFile(file)));
  const artifactText = Buffer.concat(artifactContents).toString('utf8');
  for (const sentinel of [
    'local-env-sentinel',
    'local-env-publishable-sentinel',
    'local-env-sitekey-sentinel',
    'development-local-sentinel',
    'wrong-production-target-sentinel',
    'process-env-supabase-sentinel',
    'process-env-publishable-sentinel',
    'process-env-sitekey-sentinel',
    'worker-secret-sentinel',
    'turnstile-secret-sentinel',
    'ai-secret-sentinel',
    'process-env-server-secret-sentinel',
    'process-env-turnstile-secret-sentinel',
    'process-env-ai-secret-sentinel',
    'should-be-ignored',
  ]) {
    assert.ok(!artifactText.includes(sentinel), `成果物に拒否対象の値があります: ${sentinel}`);
  }

  const clientText = artifactContents
    .filter((_, index) => artifactFiles[index].startsWith(path.join(fixtureRoot, 'dist/client')))
    .map((contents) => contents.toString('utf8'))
    .join('\n');
  for (const sentinel of [
    'https://staging-public-sentinel.invalid',
    'staging-publishable-sentinel',
    'staging-sitekey-sentinel',
  ]) {
    assert.ok(
      clientText.includes(sentinel),
      `staging公開設定がclient成果物にありません: ${sentinel}`,
    );
  }

  console.log('Release environment isolation negative case passed.');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
