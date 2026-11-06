import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  removeProductionPublicEnvironmentFile,
  writeProductionPublicEnvironmentFile,
  type ProductionReleasePublicValues,
} from '../src/build/production-connected-deployment.ts';
import { PRODUCTION_SUPABASE_URL } from '../src/build/public-config-guard.ts';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  const values: ProductionReleasePublicValues = {
    VITE_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY,
  };
  let envFilePath: string | undefined;
  let exitCode = 0;

  try {
    envFilePath = await writeProductionPublicEnvironmentFile(projectRoot, values);
    const childEnv: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'CI', 'WRANGLER_SEND_METRICS'] as const) {
      if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }
    const result = await execFileAsync('pnpm', ['build:production'], {
      cwd: projectRoot,
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    exitCode = 1;
    if (typeof error === 'object' && error !== null && 'stdout' in error) {
      const stdout = error.stdout;
      if (typeof stdout === 'string') process.stdout.write(stdout);
    }
    if (typeof error === 'object' && error !== null && 'stderr' in error) {
      const stderr = error.stderr;
      if (typeof stderr === 'string') process.stderr.write(stderr);
    }
    if (exitCode && !envFilePath) console.error('production-connected-build: INPUT_INVALID');
  } finally {
    if (envFilePath) {
      try {
        await removeProductionPublicEnvironmentFile(envFilePath);
      } catch {
        console.error('production-connected-build: ENV_FILE_CLEANUP_FAILED');
        exitCode = 1;
      }
    }
  }

  process.exitCode = exitCode;
}

await main();
