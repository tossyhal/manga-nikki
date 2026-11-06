import { describe, expect, it } from 'vitest';
import { generationOwnerAllowed } from './generation-owner';
import { mockEnvironment } from './mode';

const owner = 'aaaaaaaa-1111-4111-8111-111111111111';

describe('generation owner restriction', () => {
  it('requires an explicit production permission while preserving nonproduction defaults', () => {
    expect(generationOwnerAllowed(mockEnvironment, owner)).toBe(true);
    expect(generationOwnerAllowed({ ...mockEnvironment, APP_ENV: 'production' }, owner)).toBe(
      false,
    );
  });

  it.each(['', ' ', '*', 'ALL', 'invalid', ` ${owner}`, `${owner},${owner}`])(
    'rejects malformed permissions: %s',
    (allowed) => {
      expect(
        generationOwnerAllowed({ ...mockEnvironment, GENERATION_ALLOWED_OWNER_ID: allowed }, owner),
      ).toBe(false);
    },
  );

  it('accepts only the configured owner or the explicit all permission', () => {
    const environment = { ...mockEnvironment, GENERATION_ALLOWED_OWNER_ID: owner.toUpperCase() };
    expect(generationOwnerAllowed(environment, owner)).toBe(true);
    expect(generationOwnerAllowed(environment, 'bbbbbbbb-2222-4222-8222-222222222222')).toBe(false);
    expect(
      generationOwnerAllowed(
        { ...environment, APP_ENV: 'production', GENERATION_ALLOWED_OWNER_ID: 'all' },
        owner,
      ),
    ).toBe(true);
  });
});
