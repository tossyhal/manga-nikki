import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(projectRoot, 'dist');
const clientDir = path.join(distDir, 'client');
const target = process.env.MANGA_NIKKI_RELEASE_TARGET;
const generationInfrastructure =
  target === 'production' && process.env.PRODUCTION_GENERATION_INFRA_ENABLED === 'true';
const generationEnabled =
  generationInfrastructure && process.env.PRODUCTION_GENERATION_ENABLED === 'true';
const expectedAppEnvironment = target === 'production' ? 'production' : 'staging';

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

assert.ok(
  target === 'staging' || target === 'production' || target === 'demo',
  'Release targetがありません。',
);

const files = await collectFiles(distDir);
assert.ok(
  files.some((file) => file.startsWith(clientDir)),
  'client成果物がありません。',
);
assert.ok(
  files.every((file) => path.basename(file) !== '.dev.vars'),
  'ローカルWorker設定がrelease成果物へ含まれています。',
);

const clientFiles = files.filter((file) => file.startsWith(clientDir));
const clientContents = await Promise.all(clientFiles.map((file) => readFile(file)));
assert.ok(
  clientContents.every((contents) => !contents.includes(Buffer.from('manga-nikki.mock-session'))),
  '開発用モック認証がrelease clientへ含まれています。',
);

const workerConfigs = await Promise.all(
  files
    .filter((file) => path.basename(file) === 'wrangler.json')
    .map(async (file) => ({ file, config: JSON.parse(await readFile(file, 'utf8')) })),
);
const workerConfig = workerConfigs.find(({ config }) => config.targetEnvironment === target);
assert.ok(workerConfig, `${target}用Worker設定がありません。`);
assert.equal(workerConfig.config.vars?.APP_ENV, expectedAppEnvironment);
assert.equal(workerConfig.config.targetEnvironment, target);
assert.equal(
  workerConfig.config.name,
  target === 'production' ? 'manga-nikki' : `manga-nikki-${target}`,
);
const expectedVars =
  target === 'demo'
    ? {
        APP_ENV: 'staging',
        DATA_MODE: 'live',
        AI_MODE: 'live',
        GENERATION_ENABLED: 'false',
      }
    : target === 'production'
      ? {
          APP_ENV: 'production',
          DATA_MODE: 'live',
          AI_MODE: 'live',
          GENERATION_ENABLED: String(generationEnabled),
          SUPABASE_URL: 'https://leihsygtsamxffyybskh.supabase.co',
          SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          TURNSTILE_ALLOWED_HOSTNAMES: 'manga-nikki.tossyhal.workers.dev',
        }
      : {
          APP_ENV: expectedAppEnvironment,
          DATA_MODE: 'sample',
          AI_MODE: 'mock',
          GENERATION_ENABLED: String(generationEnabled),
        };
assert.deepEqual(workerConfig.config.vars, expectedVars);

if (target === 'production') {
  assert.equal(workerConfig.config.workers_dev, true);
  assert.equal(workerConfig.config.preview_urls, false);
  assert.deepEqual(
    workerConfig.config.triggers?.crons,
    generationInfrastructure ? ['* * * * *', '0 15 * * *'] : ['0 15 * * *'],
  );
  assert.deepEqual(workerConfig.config.secrets?.required, [
    'SUPABASE_SECRET_KEY',
    'TURNSTILE_SECRET_KEY',
    ...(generationInfrastructure ? ['OPENAI_API_KEY', 'GENERATION_ALLOWED_OWNER_ID'] : []),
  ]);
  for (const [variable, value] of Object.entries({
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY,
  })) {
    assert.ok(typeof value === 'string' && value.length > 0, `${variable}がありません。`);
    assert.ok(
      clientContents.some((contents) => contents.includes(Buffer.from(value))),
      `${variable}がclient成果物にありません。`,
    );
  }
  if (generationInfrastructure) {
    assert.deepEqual(workerConfig.config.queues, {
      producers: [{ binding: 'GENERATION_QUEUE', queue: 'manga-nikki-generations-production' }],
      consumers: [
        {
          queue: 'manga-nikki-generations-production',
          max_batch_size: 1,
          max_batch_timeout: 0,
          max_retries: 3,
          max_concurrency: 2,
        },
      ],
    });
  } else if (workerConfig.config.queues !== undefined) {
    assert.deepEqual(workerConfig.config.queues, { producers: [], consumers: [] });
  }
  assert.equal(workerConfig.config.route, undefined);
  assert.equal(workerConfig.config.routes, undefined);
}

if (target === 'demo') {
  assert.equal(workerConfig.config.workers_dev, false);
  assert.equal(workerConfig.config.preview_urls, false);
  assert.equal(workerConfig.config.route, undefined);
  assert.equal(workerConfig.config.routes, undefined);
  assert.deepEqual(workerConfig.config.queues, {
    producers: [{ binding: 'GENERATION_QUEUE', queue: 'manga-nikki-generations-demo' }],
    consumers: [
      {
        queue: 'manga-nikki-generations-demo',
        max_batch_size: 1,
        max_batch_timeout: 0,
        max_retries: 3,
        max_concurrency: 2,
      },
    ],
  });
  assert.deepEqual(workerConfig.config.triggers?.crons, ['* * * * *', '0 15 * * *']);
}
