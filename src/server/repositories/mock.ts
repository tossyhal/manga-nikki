import type { Entry, Generation } from '../../shared/schemas';
export type StoredEntry = { owner: string; requestId: string; entry: Entry };
export type StoredGeneration = {
  owner: string;
  key: string;
  revision: number;
  generation: Generation;
};
export function createMockRepository() {
  return {
    entries: new Map<string, StoredEntry>(),
    generations: new Map<string, StoredGeneration>(),
    counts: new Map<string, number>(),
  };
}
export type MockRepository = ReturnType<typeof createMockRepository>;
