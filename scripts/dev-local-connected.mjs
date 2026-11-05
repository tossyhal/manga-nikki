process.env.CLOUDFLARE_ENV = 'local-connected';

const { createServer } = await import('vite');
const server = await createServer();
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
