import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientConfig, invalidateClientConfig } from './config';

beforeEach(() => invalidateClientConfig());
afterEach(() => vi.unstubAllGlobals());

describe('public client configuration', () => {
  it('rejects unknown modes and unrecognized fields instead of falling back to mock', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        generationAvailable: true,
        dataMode: 'preview',
        consentVersion: 'v1',
        retentionDays: 30,
        supabaseSecretKey: 'must-not-be-present',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getClientConfig()).rejects.toThrow('INVALID_CONFIG');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
