import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPasswordFreeDatabaseUrl,
  createSupabaseCliEnvironment,
  runSupabaseDbPush,
  SupabaseCliFailure,
  type SupabaseCliExecution,
} from './database-migration-runner.ts';

class FakeStream extends EventEmitter {
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  pid: number | undefined = undefined;
  readonly signals: NodeJS.Signals[] = [];
  closeOnSignal: NodeJS.Signals | 'all' | 'none' = 'all';
  unrefCalled = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.closeOnSignal === 'all' || this.closeOnSignal === signal) {
      queueMicrotask(() => this.emit('close', null, signal));
    }
    return true;
  }

  unref(): this {
    this.unrefCalled = true;
    return this;
  }
}

function spawnStub(
  callback: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
    child: FakeChild,
  ) => void,
): typeof spawn {
  const spawnProcess = vi.fn(
    (command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChild();
      callback(command, args, options, child);
      return child;
    },
  );
  return spawnProcess as unknown as typeof spawn;
}

function execution(overrides: Partial<SupabaseCliExecution> = {}): SupabaseCliExecution {
  return {
    cliPath: '/tmp/pinned/supabase',
    workdir: '/tmp/restricted-workdir',
    databasePassword: 'child-password-sentinel',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Supabase db push process boundary', () => {
  it('uses a fixed password-free URL and a minimal child environment', async () => {
    vi.stubEnv('HOME', '/ambient/home');
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token');
    vi.stubEnv('BWS_ACCESS_TOKEN', 'ambient-bws-token');
    vi.stubEnv('PGHOST', 'ambient-db.example');
    vi.stubEnv('PGPASSWORD', 'ambient-password');
    let receivedCommand = '';
    let receivedArgs: readonly string[] = [];
    let receivedOptions: Record<string, unknown> | undefined;
    const signalSource = new EventEmitter();
    const spawnProcess = spawnStub((command, args, options, child) => {
      receivedCommand = command;
      receivedArgs = args;
      receivedOptions = options;
      queueMicrotask(() => child.emit('close', 0, null));
    });

    await runSupabaseDbPush(execution({ spawnProcess }), { signalSource });

    expect(receivedCommand).toBe('/tmp/pinned/supabase');
    expect(receivedOptions).toMatchObject({
      cwd: '/tmp/restricted-workdir',
      detached: process.platform === 'linux',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const environment = receivedOptions?.env as NodeJS.ProcessEnv;
    expect(environment).toEqual({
      PATH: '/tmp/pinned:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      CI: 'true',
      SUPABASE_DISABLE_TELEMETRY: 'true',
      PGPASSWORD: 'child-password-sentinel',
    });
    expect(environment).not.toHaveProperty('HOME');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('BWS_ACCESS_TOKEN');
    expect(environment).not.toHaveProperty('PGHOST');
    expect(environment).not.toHaveProperty('SUPABASE_DB_PASSWORD');
    expect(receivedArgs).toContain('--skip-vault');
    expect(receivedArgs).toContain('--yes');
    expect(receivedArgs).not.toContain('--include-all');
    expect(receivedArgs).not.toContain('--include-seed');
    expect(receivedArgs).not.toContain('--include-roles');
    expect(receivedArgs).not.toContain('--dry-run');
    expect(receivedArgs.join(' ')).not.toContain('child-password-sentinel');

    const databaseUrl = new URL(receivedArgs[receivedArgs.indexOf('--db-url') + 1] ?? '');
    expect(databaseUrl.username).toBe('postgres.leihsygtsamxffyybskh');
    expect(databaseUrl.password).toBe('');
    expect(databaseUrl.hostname).toBe('aws-0-ap-northeast-1.pooler.supabase.com');
    expect(databaseUrl.port).toBe('5432');
    expect(databaseUrl.pathname).toBe('/postgres');
    expect(databaseUrl.searchParams.get('sslmode')).toBe('verify-full');
    expect(databaseUrl.searchParams.get('sslrootcert')).toBeTruthy();
    expect(receivedArgs).toContain('/tmp/restricted-workdir');
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
  });

  it('does not include CLI output or credentials in fixed failures', async () => {
    const secret = 'child-password-sentinel';
    const rawSql = 'CREATE TABLE private.user_data(secret text)';
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`bad ${rawSql} ${secret}`));
        child.stderr.emit('data', Buffer.from(`connection rejected ${secret}`));
        child.emit('close', 1, null);
      });
    });

    await expect(runSupabaseDbPush(execution({ spawnProcess }))).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(SupabaseCliFailure);
        expect((error as Error).message).toBe('CLI_COMMAND_FAILED');
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).not.toContain(rawSql);
        return true;
      },
    );
  });

  it('terminates a timed out process and maps the result to a fixed code', async () => {
    let childProcess: FakeChild | undefined;
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      childProcess = child;
    });

    await expect(
      runSupabaseDbPush(execution({ spawnProcess, timeoutMs: 1 })),
    ).rejects.toMatchObject({ code: 'CLI_TIMEOUT' });
    expect(childProcess?.signals).toContain('SIGTERM');
  });

  it('kills an oversized-output process and does not retain its output', async () => {
    let childProcess: FakeChild | undefined;
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      childProcess = child;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('0123456789')));
    });

    await expect(
      runSupabaseDbPush(execution({ spawnProcess, maxOutputBytes: 1 })),
    ).rejects.toMatchObject({ code: 'CLI_OUTPUT_TOO_LARGE' });
    expect(childProcess?.signals).toContain('SIGKILL');
  });

  it('maps spawn failures without exposing the platform error', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('secret-containing platform error');
    }) as unknown as typeof spawn;
    await expect(runSupabaseDbPush(execution({ spawnProcess }))).rejects.toMatchObject({
      code: 'CLI_START_FAILED',
      message: 'CLI_START_FAILED',
    });
    expect(buildPasswordFreeDatabaseUrl()).not.toContain('child-password-sentinel');
    expect(createSupabaseCliEnvironment('/tmp/pinned/supabase', 'secret').PGPASSWORD).toBe(
      'secret',
    );
  });

  it('forwards parent SIGTERM and SIGINT, force kills after the grace period, and removes handlers', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const signalSource = new EventEmitter();
      let childProcess: FakeChild | undefined;
      const spawnProcess = spawnStub((_command, _args, _options, child) => {
        childProcess = child;
        child.closeOnSignal = 'SIGKILL';
      });
      const pending = runSupabaseDbPush(execution({ spawnProcess }), {
        signalSource,
        forceKillDelayMs: 1,
      });

      expect(signalSource.listenerCount('SIGTERM')).toBe(1);
      expect(signalSource.listenerCount('SIGINT')).toBe(1);
      signalSource.emit(signal);
      await expect(pending).rejects.toMatchObject({
        code: 'CLI_INTERRUPTED',
        message: 'CLI_INTERRUPTED',
      });
      expect(childProcess?.signals).toEqual([signal, 'SIGKILL']);
      expect(signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(signalSource.listenerCount('SIGINT')).toBe(0);
    }
  });

  it('removes parent signal handlers when the child emits an error', async () => {
    const signalSource = new EventEmitter();
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      queueMicrotask(() => child.emit('error', new Error('platform detail')));
    });

    await expect(
      runSupabaseDbPush(execution({ spawnProcess }), { signalSource }),
    ).rejects.toMatchObject({ code: 'CLI_START_FAILED' });
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
  });

  it('settles and releases process handles if a child remains open after SIGKILL', async () => {
    const signalSource = new EventEmitter();
    let childProcess: FakeChild | undefined;
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      childProcess = child;
      child.closeOnSignal = 'none';
    });
    const pending = runSupabaseDbPush(execution({ spawnProcess }), {
      signalSource,
      forceKillDelayMs: 1,
      settleAfterKillDelayMs: 1,
    });

    signalSource.emit('SIGTERM');
    await expect(pending).rejects.toMatchObject({ code: 'CLI_INTERRUPTED' });
    expect(childProcess?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(childProcess?.stdout.destroyed).toBe(true);
    expect(childProcess?.stderr.destroyed).toBe(true);
    expect(childProcess?.unrefCalled).toBe(true);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
  });

  it('kills the remaining group immediately when a cancelled parent closes first', async () => {
    const killGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      for (const [index, termination] of ['close', 'error'].entries()) {
        const signalSource = new EventEmitter();
        const timersBeforeRun = vi.getTimerCount();
        let cancelledChild: FakeChild | undefined;
        const childPid = 43125 + index;
        const cancelledSpawn = spawnStub((_command, _args, _options, child) => {
          child.pid = childPid;
          cancelledChild = child;
        });
        const pending = runSupabaseDbPush(execution({ spawnProcess: cancelledSpawn }), {
          signalSource,
          forceKillDelayMs: 10_000,
        });

        signalSource.emit('SIGTERM');
        expect(killGroup).toHaveBeenNthCalledWith(index * 2 + 1, -childPid, 'SIGTERM');
        if (termination === 'close') cancelledChild?.emit('close', 0, null);
        else cancelledChild?.emit('error', new Error('platform detail'));
        await expect(pending).rejects.toMatchObject({ code: 'CLI_INTERRUPTED' });

        expect(killGroup).toHaveBeenNthCalledWith(index * 2 + 2, -childPid, 'SIGKILL');
        expect(signalSource.listenerCount('SIGTERM')).toBe(0);
        expect(signalSource.listenerCount('SIGINT')).toBe(0);
        expect(vi.getTimerCount()).toBe(timersBeforeRun);
      }
    } finally {
      killGroup.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not kill a process group when the CLI exits normally', async () => {
    const killGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const signalSource = new EventEmitter();
    const spawnProcess = spawnStub((_command, _args, _options, child) => {
      child.pid = 43126;
      queueMicrotask(() => child.emit('close', 0, null));
    });
    try {
      await runSupabaseDbPush(execution({ spawnProcess }), { signalSource });
      expect(killGroup).not.toHaveBeenCalled();
      expect(signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(signalSource.listenerCount('SIGINT')).toBe(0);
    } finally {
      killGroup.mockRestore();
    }
  });
});
