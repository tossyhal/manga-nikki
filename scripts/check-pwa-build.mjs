import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientDir = fileURLToPath(new URL('../dist/client/', import.meta.url));
const manifest = JSON.parse(await readFile(`${clientDir}manifest.webmanifest`, 'utf8'));
const worker = await readFile(`${clientDir}sw.js`, 'utf8');
const config = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
const files = await readdir(`${clientDir}assets`);
const precache = worker.match(/precacheAndRoute\(\[(.*?)\],\{\}\)/)?.[1];

assert.ok(precache, 'Service Workerに明示的な事前キャッシュ一覧がありません。');
assert.equal(manifest.lang, 'ja');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');

const precacheUrls = [...precache.matchAll(/url:"([^"]+)"/g)].map((match) => match[1]);
assert.ok(precacheUrls.includes('index.html'), 'アプリ画面がオフライン用キャッシュにありません。');
assert.ok(
  precacheUrls.includes('sample-comic.svg'),
  '架空サンプルがオフライン用キャッシュにありません。',
);
assert.ok(
  precacheUrls.includes('manifest.webmanifest'),
  'Web App Manifestがキャッシュ一覧にありません。',
);
assert.ok(precacheUrls.includes('icon-192.png'));
assert.ok(precacheUrls.includes('icon-512.png'));
assert.ok(precacheUrls.some((url) => /^assets\/.+\.js$/.test(url)));
assert.ok(precacheUrls.some((url) => /^assets\/.+\.css$/.test(url)));
assert.equal(
  new Set(precacheUrls).size,
  precacheUrls.length,
  '事前キャッシュ項目が重複しています。',
);

for (const url of precacheUrls) {
  const isAppShell = url === 'index.html' || url === 'manifest.webmanifest';
  const isStaticAsset = /^assets\/.+\.(?:js|css)$/.test(url);
  const isPublicFixture = ['icon-192.png', 'icon-512.png', 'sample-comic.svg'].includes(url);
  assert.ok(
    isAppShell || isStaticAsset || isPublicFixture,
    `許可していないキャッシュ対象です: ${url}`,
  );
}

for (const icon of manifest.icons) {
  assert.ok(icon.sizes === '192x192' || icon.sizes === '512x512');
  await readFile(`${clientDir}${icon.src.slice(1)}`);
}

assert.match(config, /registerType:\s*'prompt'/);
assert.match(config, /skipWaiting:\s*false/);
assert.match(config, /clientsClaim:\s*false/);
assert.equal((worker.match(/registerRoute\(/g) ?? []).length, 1);
assert.match(worker, /NavigationRoute/);
assert.match(worker, /SKIP_WAITING/);
assert.equal((worker.match(/self\.skipWaiting\(\)/g) ?? []).length, 1);
assert.doesNotMatch(worker, /clientsClaim/);

const appBundle = files.find((file) => /^index-.+\.js$/.test(file));
assert.ok(appBundle, 'アプリケーションのバージョン付きJSがありません。');
const appSource = await readFile(`${clientDir}assets/${appBundle}`, 'utf8');
assert.match(appSource, /updateServiceWorker/);
assert.doesNotMatch(appSource, /autoUpdate/);

console.log(
  'PWA build policy passed: static shell and fictional sample only; prompt updates enabled.',
);
