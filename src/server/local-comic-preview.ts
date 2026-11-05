import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 明示した生成結果フォルダ内のHTMLとコマ画像だけを配信する。AIは呼び出さない。
export async function startComicPreview(directory: string) {
  const root = resolve(directory);
  if (!(await stat(join(root, 'index.html'))).isFile())
    throw new Error('プレビューHTMLがありません。');
  const server = createServer(async (request, response) => {
    const address = server.address();
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (
      request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== `http://${host}`)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    // クエリ・エンコードされたパス・親ディレクトリ参照も受け付けない。
    const path = request.url === '/' ? '/index.html' : (request.url ?? '');
    const mime =
      path === '/index.html'
        ? 'text/html; charset=utf-8'
        : /^\/panel-[1-4]\.png$/.test(path)
          ? 'image/png'
          : /^\/panel-[1-4]\.jpg$/.test(path)
            ? 'image/jpeg'
            : /^\/panel-[1-4]\.webp$/.test(path)
              ? 'image/webp'
              : undefined;
    if (!mime) {
      response.writeHead(404).end();
      return;
    }
    try {
      const file = join(root, path.slice(1));
      const info = await stat(file);
      if (!info.isFile() || info.size > (path === '/index.html' ? 64 * 1024 : 8 * 1024 * 1024)) {
        response.writeHead(404).end();
        return;
      }
      const data = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('プレビューを起動できません。');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}
