import { z } from 'zod';
export const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']),
  DATA_MODE: z.enum(['mock', 'live', 'sample']),
  AI_MODE: z.enum(['mock', 'live']),
  GENERATION_ENABLED: z.enum(['true', 'false']).default('false'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
});
export type Environment = z.infer<typeof environmentSchema>;
export type Mode = 'local-mock' | 'local-connected' | 'preview-sample' | 'live-demo';
export function resolveMode(input: unknown, localDevelopment: boolean): Mode {
  const env = environmentSchema.parse(input);
  if (
    env.APP_ENV === 'development' &&
    env.DATA_MODE === 'mock' &&
    env.AI_MODE === 'mock' &&
    env.GENERATION_ENABLED === 'false' &&
    localDevelopment
  )
    return 'local-mock';
  if (
    env.APP_ENV !== 'production' &&
    env.DATA_MODE === 'live' &&
    env.AI_MODE === 'mock' &&
    env.GENERATION_ENABLED === 'false'
  )
    return 'local-connected';
  if (
    env.APP_ENV !== 'development' &&
    env.DATA_MODE === 'sample' &&
    env.AI_MODE === 'mock' &&
    env.GENERATION_ENABLED === 'false'
  )
    return 'preview-sample';
  if (env.APP_ENV !== 'development' && env.DATA_MODE === 'live' && env.AI_MODE === 'live')
    return 'live-demo';
  throw new Error('INVALID_MODE');
}
export const mockEnvironment: Environment = {
  APP_ENV: 'development',
  DATA_MODE: 'mock',
  AI_MODE: 'mock',
  GENERATION_ENABLED: 'false',
};
