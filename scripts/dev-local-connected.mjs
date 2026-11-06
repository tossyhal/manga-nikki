import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connectedVarsPath = resolve(projectRoot, '.dev.vars.local-connected');
let connectedVarsExists = false;
try {
  connectedVarsExists = (await stat(connectedVarsPath)).isFile();
} catch {
  connectedVarsExists = false;
}

if (!connectedVarsExists) {
  console.error(
    'ローカル接続用の設定ファイル「.dev.vars.local-connected」がありません。dev.vars.local-connected.exampleから作成してからpnpm dev:connectedを実行してください。',
  );
  process.exit(1);
}

process.env.CLOUDFLARE_ENV = 'local-connected';

const { createServer } = await import('vite');
const server = await createServer({ root: projectRoot });
await server.listen();
server.printUrls();

let closing = false;
async function closeServer() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } catch (error) {
    console.error('Failed to stop the local-connected development server.', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void closeServer());
process.once('SIGTERM', () => void closeServer());
