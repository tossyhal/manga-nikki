import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDirectory = resolve(fileURLToPath(new URL('../dist/client/', import.meta.url)));

async function startFixtureServer() {
  let serviceWorkerVersion = 1;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/sw.js') {
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        response.end(`
          const version = ${serviceWorkerVersion};
          self.addEventListener('message', (event) => {
            if (event.data?.type === 'GET_VERSION') {
              event.ports[0]?.postMessage(version);
            }
            if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
          });
          if (version > 1) {
            self.addEventListener('activate', (event) => {
              event.waitUntil(self.clients.claim());
            });
          }
        `);
        return;
      }

      if (pathname === '/api/v1/config') {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(
          JSON.stringify({
            dataMode: 'mock',
            generationAvailable: true,
            consentVersion: 'v1',
            retentionDays: 30,
          }),
        );
        return;
      }

      const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
      const filePath = resolve(clientDirectory, relativePath);
      const isWithinClientDirectory =
        filePath === clientDirectory || filePath.startsWith(`${clientDirectory}${sep}`);
      if (!isWithinClientDirectory) {
        response.writeHead(404).end();
        return;
      }

      const requestedPath = pathname === '/' ? 'index.html' : relativePath;
      const requestedFile = resolve(clientDirectory, requestedPath);
      let body: Buffer;
      let servedPath = requestedFile;
      try {
        body = await readFile(requestedFile);
      } catch {
        servedPath = resolve(clientDirectory, 'index.html');
        body = await readFile(servedPath);
      }

      const contentType: Record<string, string> = {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
      };
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': contentType[extname(servedPath)] ?? 'application/octet-stream',
      });
      response.end(body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server did not bind a port.');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    publishVersion(version: number) {
      serviceWorkerVersion = version;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function addBootCounter(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const key = '__pwaBootCount';
    const count = Number(sessionStorage.getItem(key) ?? 0) + 1;
    sessionStorage.setItem(key, String(count));
  });
}

async function getControlledServiceWorkerVersion(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolveVersion) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          resolveVersion(null);
          return;
        }
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => resolveVersion(null), 1_000);
        channel.port1.addEventListener('message', (event) => {
          window.clearTimeout(timeout);
          channel.port1.close();
          resolveVersion(Number(event.data));
        });
        channel.port1.start();
        controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      }),
  );
}

test('別タブから明示更新しても未保存の日記タブは保たれる', async ({ browser }) => {
  const fixture = await startFixtureServer();
  const context = await browser.newContext();

  try {
    const pageA = await context.newPage();
    await addBootCounter(pageA);
    await pageA.goto(fixture.origin);
    await expect(pageA.getByRole('heading', { name: '今日の記録' })).toBeAttached();
    await pageA.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await pageA.reload();
    await expect
      .poll(() => pageA.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);
    await expect.poll(() => getControlledServiceWorkerVersion(pageA)).toBe(1);

    const pageB = await context.newPage();
    await addBootCounter(pageB);
    let pageBNavigations = 0;
    pageB.on('framenavigated', (frame) => {
      if (frame === pageB.mainFrame()) pageBNavigations += 1;
    });
    await pageB.goto(`${fixture.origin}/new`);
    await expect.poll(() => getControlledServiceWorkerVersion(pageB)).toBe(1);
    const diary = pageB.getByLabel('日記', { exact: true });
    await diary.fill('更新中も残す架空の日記');
    const initialPageBNavigations = pageBNavigations;

    fixture.publishVersion(2);
    await pageA.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect(pageA.getByRole('button', { name: '更新する' })).toBeEnabled();
    await expect(pageB.getByRole('button', { name: '更新する' })).toBeDisabled();

    const pageAReload = pageA.waitForEvent('load');
    await pageA.getByRole('button', { name: '更新する' }).click();
    await expect.poll(() => getControlledServiceWorkerVersion(pageB)).toBe(2);
    await pageAReload;
    expect(await pageA.evaluate(() => Number(sessionStorage.getItem('__pwaBootCount')))).toBe(3);
    await expect(pageB).toHaveURL(`${fixture.origin}/new`);
    await expect(diary).toHaveValue('更新中も残す架空の日記');
    await expect(
      pageB.getByText(
        '別のタブで新しいバージョンが適用されました。この画面は入力内容を保つため再読み込みしていません。',
      ),
    ).toBeVisible();
    await expect
      .poll(() => pageB.evaluate(() => Number(sessionStorage.getItem('__pwaBootCount'))))
      .toBe(1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    expect(pageBNavigations).toBe(initialPageBNavigations);

    await diary.fill('');
    const applyUpdate = pageB.getByRole('button', { name: 'この画面を再読み込み' });
    await expect(applyUpdate).toBeEnabled();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await expect
      .poll(() => pageB.evaluate(() => Number(sessionStorage.getItem('__pwaBootCount'))))
      .toBe(1);
    const pageBReload = pageB.waitForEvent('load');
    await applyUpdate.click();
    await pageBReload;
    expect(await pageB.evaluate(() => Number(sessionStorage.getItem('__pwaBootCount')))).toBe(2);
  } finally {
    await context.close();
    await fixture.close();
  }
});
