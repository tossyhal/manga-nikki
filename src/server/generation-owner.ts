import { z } from 'zod';
import type { Environment } from './mode';

export function generationOwnerAllowed(environment: Environment, owner: string): boolean {
  const allowedOwner = environment.GENERATION_ALLOWED_OWNER_ID;
  if (allowedOwner === undefined) return environment.APP_ENV !== 'production';
  if (allowedOwner === 'all') return true;
  const parsed = z.uuid().safeParse(allowedOwner);
  return parsed.success && parsed.data.toLowerCase() === owner.toLowerCase();
}
