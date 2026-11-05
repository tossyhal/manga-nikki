import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(projectRoot, 'dist');
const clientDir = path.join(distDir, 'client');
const target = process.env.MANGA_NIKKI_RELEASE_TARGET;
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
assert.equal(workerConfig.config.name, `manga-nikki-${target}`);
const expectedVars =
  target === 'demo'
    ? {
        APP_ENV: 'staging',
        DATA_MODE: 'live',
        AI_MODE: 'live',
        GENERATION_ENABLED: 'false',
      }
    : {
        APP_ENV: expectedAppEnvironment,
        DATA_MODE: 'sample',
        AI_MODE: 'mock',
        GENERATION_ENABLED: 'false',
      };
assert.deepEqual(workerConfig.config.vars, expectedVars);

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
