import type { ClientConfig } from '../lib/config';
import type { DiaryActivity } from '../features/diary/diaryActivity';

export type AppContext = {
  config: ClientConfig | null;
  configError: boolean;
  personalDataAvailable: boolean;
  onActivityChange: (activity: DiaryActivity) => void;
  retryConfig: () => void;
};
