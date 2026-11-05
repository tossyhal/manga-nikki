import type { Entry, Generation } from '../../shared/schemas';
export type StoredEntry = {
  owner: string;
  requestId: string;
  createFingerprint: string;
  entry: Entry;
};
export type StoredGeneration = {
  owner: string;
  key: string;
  generation: Generation;
};
export function createMockRepository() {
  return {
    entries: new Map<string, StoredEntry>(),
    generations: new Map<string, StoredGeneration>(),
    counts: new Map<string, number>(),
    entryTombstones: new Set<string>(),
  };
}
export type MockRepository = ReturnType<typeof createMockRepository>;
