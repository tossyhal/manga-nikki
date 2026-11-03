import type { ClientConfig } from '../../src/client/lib/config';
import type { EntryDetail } from '../../src/shared/schemas';

export const mockClientConfigFixture = {
  dataMode: 'mock',
  generationAvailable: true,
  consentVersion: 'v1',
  retentionDays: 30,
} satisfies ClientConfig;

export const liveClientConfigFixture = {
  dataMode: 'live',
  generationAvailable: false,
  consentVersion: 'v1',
  retentionDays: 30,
} satisfies ClientConfig;

export const draftEntryDetailFixture: EntryDetail = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  diaryDate: '2026-01-01',
  body: '画面確認専用の架空日記です。',
  revision: 1,
  latestGenerationId: null,
  latestGeneration: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
