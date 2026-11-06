import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  '.env.demo.example',
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

function jwtWithRole(role, marker) {
  const payload = Buffer.from(JSON.stringify({ role, marker })).toString('base64url');
  return `header.${payload}.signature`;
}

async function assertPublicConfigRejected(args, env, variable, sentinels) {
  let failure;
  try {
    await execFileAsync(process.execPath, args, {
      cwd: fixtureRoot,
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, '不正な公開設定を受け付けてしまいました。');
  assert.notEqual(failure.code, 'ETIMEDOUT', '不正な公開設定の拒否でタイムアウトしました。');
  const output = [failure.stdout, failure.stderr]
    .filter((part) => typeof part === 'string')
    .join('\n');
  assert.ok(output.includes(variable), '拒否メッセージに変数名がありません。');
  assert.ok(output.includes('サーバー専用キー形式'), '拒否理由が固定メッセージにありません。');
  for (const sentinel of sentinels) {
    assert.ok(!output.includes(sentinel), '拒否メッセージに公開設定値が含まれています。');
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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
  const safeStagingEnvironment = [
    'VITE_SUPABASE_URL=https://staging-public-sentinel.invalid',
    'VITE_SUPABASE_PUBLISHABLE_KEY=staging-publishable-sentinel',
    'VITE_TURNSTILE_SITE_KEY=staging-sitekey-sentinel',
  ].join('\n');
  const safeDemoEnvironment = [
    'VITE_SUPABASE_URL=https://demo-public-sentinel.invalid',
    'VITE_SUPABASE_PUBLISHABLE_KEY=demo-publishable-sentinel',
    'VITE_TURNSTILE_SITE_KEY=demo-sitekey-sentinel',
  ].join('\n');
  await writeFile(path.join(fixtureRoot, '.env.staging.local'), safeStagingEnvironment);
  await writeFile(path.join(fixtureRoot, '.env.demo.local'), safeDemoEnvironment);
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
      'OPENAI_API_KEY="ai-secret-sentinel"',
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
    OPENAI_API_KEY: 'process-env-ai-secret-sentinel',
  };

  const devSecretJwt = jwtWithRole('service_role', 'dev-jwt-payload-sentinel');
  await assertPublicConfigRejected(
    ['node_modules/vite/bin/vite.js'],
    { ...childEnvironment, VITE_SUPABASE_PUBLISHABLE_KEY: devSecretJwt },
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    [devSecretJwt, 'dev-jwt-payload-sentinel'],
  );
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    '拒否後にclient成果物が作られています。',
  );

  const releaseSecret = 'sb_secret_release-build-sentinel';
  await writeFile(
    path.join(fixtureRoot, '.env.staging.local'),
    [
      'VITE_SUPABASE_URL=https://staging-public-sentinel.invalid',
      `VITE_SUPABASE_PUBLISHABLE_KEY=${releaseSecret}`,
      'VITE_TURNSTILE_SITE_KEY=staging-sitekey-sentinel',
    ].join('\n'),
  );
  await assertPublicConfigRejected(
    ['scripts/build-environment.mjs', 'staging'],
    childEnvironment,
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    [releaseSecret],
  );
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    '拒否後にclient成果物が作られています。',
  );
  await writeFile(path.join(fixtureRoot, '.env.staging.local'), safeStagingEnvironment);

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
    'demo-public-sentinel',
    'demo-publishable-sentinel',
    'demo-sitekey-sentinel',
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

  await rm(path.join(fixtureRoot, 'dist'), { recursive: true, force: true });
  await rm(path.join(fixtureRoot, '.env.production.local'));
  assert.equal(
    await exists(path.join(fixtureRoot, '.env.production.local')),
    false,
    'productionの公開設定ファイルはない状態でbuildします。',
  );
  try {
    await execFileAsync(process.execPath, ['scripts/build-environment.mjs', 'production'], {
      cwd: fixtureRoot,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `隔離fixtureのproduction sample buildが失敗しました。${details ? `\n${details}` : ''}`,
    );
  }
  const productionArtifactFiles = await collectFiles(path.join(fixtureRoot, 'dist'));
  const productionArtifactContents = await Promise.all(
    productionArtifactFiles.map((file) => readFile(file)),
  );
  const productionArtifactText = Buffer.concat(productionArtifactContents).toString('utf8');
  for (const sentinel of [
    'wrong-production-target-sentinel',
    'process-env-supabase-sentinel',
    'process-env-publishable-sentinel',
    'process-env-sitekey-sentinel',
    'process-env-server-secret-sentinel',
    'process-env-turnstile-secret-sentinel',
    'process-env-ai-secret-sentinel',
    'worker-secret-sentinel',
    'turnstile-secret-sentinel',
    'ai-secret-sentinel',
  ]) {
    assert.ok(
      !productionArtifactText.includes(sentinel),
      `production成果物へ値が混入しました: ${sentinel}`,
    );
  }
  const productionWorkerConfigPath = productionArtifactFiles.find(
    (file) => path.basename(file) === 'wrangler.json',
  );
  assert.ok(productionWorkerConfigPath, 'production Worker設定が成果物にありません。');
  const productionWorkerConfig = JSON.parse(await readFile(productionWorkerConfigPath, 'utf8'));
  assert.equal(productionWorkerConfig.name, 'manga-nikki');
  assert.equal(productionWorkerConfig.targetEnvironment, 'production');
  assert.deepEqual(productionWorkerConfig.vars, {
    APP_ENV: 'production',
    DATA_MODE: 'sample',
    AI_MODE: 'mock',
    GENERATION_ENABLED: 'false',
  });
  assert.equal(productionWorkerConfig.workers_dev, true);
  assert.equal(productionWorkerConfig.preview_urls, false);
  assert.deepEqual(productionWorkerConfig.triggers?.crons, []);
  if (productionWorkerConfig.queues !== undefined) {
    assert.deepEqual(productionWorkerConfig.queues, { producers: [], consumers: [] });
  }

  await rm(path.join(fixtureRoot, 'dist'), { recursive: true, force: true });
  await rm(path.join(fixtureRoot, '.env.demo.local'));
  let missingDemoFailure;
  try {
    await execFileAsync(process.execPath, ['scripts/build-environment.mjs', 'demo'], {
      cwd: fixtureRoot,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (error) {
    missingDemoFailure = error;
  }
  assert.ok(missingDemoFailure, '公開設定がないdemo buildを受け付けてしまいました。');
  assert.notEqual(missingDemoFailure.code, 'ETIMEDOUT');
  const missingDemoOutput = [missingDemoFailure.stdout, missingDemoFailure.stderr]
    .filter((part) => typeof part === 'string')
    .join('\n');
  for (const variable of [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_TURNSTILE_SITE_KEY',
  ]) {
    assert.ok(missingDemoOutput.includes(variable), `missing設定に変数名がありません: ${variable}`);
  }
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    'missing設定の拒否後にclient成果物が作られています。',
  );

  const demoSecret = 'sb_secret_demo-build-sentinel';
  await writeFile(
    path.join(fixtureRoot, '.env.demo.local'),
    [
      'VITE_SUPABASE_URL=https://demo-public-sentinel.invalid',
      `VITE_SUPABASE_PUBLISHABLE_KEY=${demoSecret}`,
      'VITE_TURNSTILE_SITE_KEY=demo-sitekey-sentinel',
    ].join('\n'),
  );
  await assertPublicConfigRejected(
    ['scripts/build-environment.mjs', 'demo'],
    childEnvironment,
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    [demoSecret],
  );
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    'secret形式の拒否後にclient成果物が作られています。',
  );

  const demoOpenAiKey = 'sk-proj-demo-build-sentinel';
  await writeFile(
    path.join(fixtureRoot, '.env.demo.local'),
    [
      'VITE_SUPABASE_URL=https://demo-public-sentinel.invalid',
      `VITE_SUPABASE_PUBLISHABLE_KEY=${demoOpenAiKey}`,
      'VITE_TURNSTILE_SITE_KEY=demo-sitekey-sentinel',
    ].join('\n'),
  );
  await assertPublicConfigRejected(
    ['scripts/build-environment.mjs', 'demo'],
    childEnvironment,
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    [demoOpenAiKey],
  );
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    'OpenAI secret形式の拒否後にclient成果物が作られています。',
  );

  const demoServerSecret = 'demo-server-secret-sentinel';
  await writeFile(
    path.join(fixtureRoot, '.env.demo.local'),
    [
      'VITE_SUPABASE_URL=https://demo-public-sentinel.invalid',
      'VITE_SUPABASE_PUBLISHABLE_KEY=demo-publishable-sentinel',
      'VITE_TURNSTILE_SITE_KEY=demo-sitekey-sentinel',
      `OPENAI_API_KEY=${demoServerSecret}`,
    ].join('\n'),
  );
  let unsupportedDemoFailure;
  try {
    await execFileAsync(process.execPath, ['scripts/build-environment.mjs', 'demo'], {
      cwd: fixtureRoot,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (error) {
    unsupportedDemoFailure = error;
  }
  assert.ok(unsupportedDemoFailure, 'demoの公開設定にWorker secretを受け付けてしまいました。');
  assert.notEqual(unsupportedDemoFailure.code, 'ETIMEDOUT');
  const unsupportedDemoOutput = [unsupportedDemoFailure.stdout, unsupportedDemoFailure.stderr]
    .filter((part) => typeof part === 'string')
    .join('\n');
  assert.ok(unsupportedDemoOutput.includes('OPENAI_API_KEY'));
  assert.ok(!unsupportedDemoOutput.includes(demoServerSecret));
  assert.equal(
    await exists(path.join(fixtureRoot, 'dist', 'client')),
    false,
    'Worker secret設定の拒否後にclient成果物が作られています。',
  );

  await writeFile(path.join(fixtureRoot, '.env.demo.local'), safeDemoEnvironment);
  try {
    await execFileAsync(process.execPath, ['scripts/build-environment.mjs', 'demo'], {
      cwd: fixtureRoot,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`隔離fixtureのdemo buildが失敗しました。${details ? `\n${details}` : ''}`);
  }

  const demoArtifactFiles = await collectFiles(path.join(fixtureRoot, 'dist'));
  const demoWorkerConfigPath = demoArtifactFiles.find(
    (file) => path.basename(file) === 'wrangler.json',
  );
  assert.ok(demoWorkerConfigPath, 'demo Worker設定が成果物にありません。');
  const validDemoWorkerConfig = await readFile(demoWorkerConfigPath, 'utf8');
  const routedDemoWorkerConfig = JSON.parse(validDemoWorkerConfig);
  routedDemoWorkerConfig.route = 'demo.example.invalid/*';
  await writeFile(demoWorkerConfigPath, JSON.stringify(routedDemoWorkerConfig));
  let unexpectedRouteFailure;
  try {
    await execFileAsync(process.execPath, ['scripts/check-release-build.mjs'], {
      cwd: fixtureRoot,
      env: { ...childEnvironment, MANGA_NIKKI_RELEASE_TARGET: 'demo' },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    unexpectedRouteFailure = error;
  } finally {
    await writeFile(demoWorkerConfigPath, validDemoWorkerConfig);
  }
  assert.ok(unexpectedRouteFailure, 'route単数形があるdemo設定を受け付けてしまいました。');

  const demoArtifactContents = await Promise.all(demoArtifactFiles.map((file) => readFile(file)));
  const demoArtifactText = Buffer.concat(demoArtifactContents).toString('utf8');
  for (const sentinel of [
    'local-env-sentinel',
    'local-env-publishable-sentinel',
    'local-env-sitekey-sentinel',
    'development-local-sentinel',
    'wrong-production-target-sentinel',
    'staging-public-sentinel',
    'staging-publishable-sentinel',
    'staging-sitekey-sentinel',
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
    assert.ok(
      !demoArtifactText.includes(sentinel),
      `demo成果物へ別環境の値が混入しました: ${sentinel}`,
    );
  }

  const demoClientText = demoArtifactContents
    .filter((_, index) =>
      demoArtifactFiles[index].startsWith(path.join(fixtureRoot, 'dist/client')),
    )
    .map((contents) => contents.toString('utf8'))
    .join('\n');
  for (const sentinel of [
    'https://demo-public-sentinel.invalid',
    'demo-publishable-sentinel',
    'demo-sitekey-sentinel',
  ]) {
    assert.ok(
      demoClientText.includes(sentinel),
      `demo公開設定がclient成果物にありません: ${sentinel}`,
    );
  }

  console.log('Release environment isolation and demo target checks passed.');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
