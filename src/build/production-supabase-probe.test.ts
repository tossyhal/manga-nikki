import { describe, expect, it, vi } from 'vitest';
import { ProductionConnectedDeploymentFailure } from './production-connected-deployment';
import { runProductionSupabaseConnectionProbe } from './production-supabase-probe';

const probeInput = {
  supabaseUrl: 'https://leihsygtsamxffyybskh.supabase.co',
  publishableKey: 'sb_publishable_public-sentinel',
  secretKey: 'sb_secret_private-sentinel',
};

describe('read-only production Supabase connection probe', () => {
  it('checks Auth settings and a read-only quota RPC using apikey only', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return calls.length === 1
        ? new Response(JSON.stringify({ disable_signup: false }), { status: 200 })
        : new Response(
            JSON.stringify({
              remaining_today: 1,
              generation_available: false,
              profile_is_mock: false,
              reset_at: '2030-01-01T00:00:00Z',
              active_generation_id: null,
            }),
            { status: 200 },
          );
    };

    await expect(
      runProductionSupabaseConnectionProbe(probeInput, fetcher),
    ).resolves.toBeUndefined();
    expect(calls.map(({ input }) => input)).toEqual([
      `${probeInput.supabaseUrl}/auth/v1/settings`,
      `${probeInput.supabaseUrl}/rest/v1/rpc/get_generation_quota`,
    ]);
    expect(calls.map(({ init }) => init.method)).toEqual(['GET', 'POST']);
    expect(calls[0]?.init.headers).toEqual({
      apikey: probeInput.publishableKey,
      accept: 'application/json',
    });
    expect(calls[1]?.init.headers).toEqual({
      apikey: probeInput.secretKey,
      accept: 'application/json',
      'content-type': 'application/json',
    });
    for (const call of calls) {
      expect(new Headers(call.init.headers).has('authorization')).toBe(false);
      expect(call.init.redirect).toBe('error');
      expect(call.init.cache).toBe('no-store');
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      p_actor_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it.each([true, false])(
    'allows the live DB emergency stop with the generation profile (available=%s)',
    async (available) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              remaining_today: 0,
              generation_available: available,
              profile_is_mock: false,
              reset_at: '2030-01-01T00:00:00Z',
              active_generation_id: null,
            }),
            { status: 200 },
          ),
        );
      await expect(
        runProductionSupabaseConnectionProbe({ ...probeInput, generationEnabled: true }, fetcher),
      ).resolves.toBeUndefined();
    },
  );

  it('adds a bearer header only for a legacy service_role JWT', async () => {
    const legacyKey = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init = {}) => {
      calls.push(init);
      return calls.length === 1
        ? new Response(JSON.stringify({ disable_signup: false }), { status: 200 })
        : new Response(
            JSON.stringify({
              remaining_today: 1,
              generation_available: false,
              profile_is_mock: false,
              reset_at: '2030-01-01T00:00:00Z',
              active_generation_id: null,
            }),
            { status: 200 },
          );
    };
    await runProductionSupabaseConnectionProbe({ ...probeInput, secretKey: legacyKey }, fetcher);
    expect(new Headers(calls[0]?.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[1]?.headers).get('authorization')).toBe(`Bearer ${legacyKey}`);
  });

  it('fails closed for wrong target, bad JSON, oversized data and HTTP errors without response details', async () => {
    const first = vi.fn(async () => new Response('private-body-sentinel', { status: 500 }));
    await expect(
      runProductionSupabaseConnectionProbe(
        { ...probeInput, supabaseUrl: 'https://other.invalid' },
        first,
      ),
    ).rejects.toMatchObject({
      code: 'SUPABASE_PROBE_FAILED',
    });
    await expect(runProductionSupabaseConnectionProbe(probeInput, first)).rejects.toMatchObject({
      code: 'SUPABASE_PROBE_FAILED',
      message: 'SUPABASE_PROBE_FAILED',
    });
    await expect(
      runProductionSupabaseConnectionProbe(
        probeInput,
        vi.fn(async () => new Response('not-json', { status: 200 })),
      ),
    ).rejects.toMatchObject({ message: 'SUPABASE_PROBE_FAILED' });
    await expect(
      runProductionSupabaseConnectionProbe(
        probeInput,
        vi.fn(async () => new Response('x'.repeat(33 * 1024), { status: 200 })),
      ),
    ).rejects.toBeInstanceOf(ProductionConnectedDeploymentFailure);
    await expect(runProductionSupabaseConnectionProbe(probeInput, first)).rejects.toThrow(
      'SUPABASE_PROBE_FAILED',
    );
  });
});
