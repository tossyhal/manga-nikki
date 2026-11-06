export type DiaryActivity = {
  dirty: boolean;
  busy: boolean;
  failed: boolean;
  entrySaveStarted?: boolean;
  generationNavigation?: {
    stage: 'saving' | 'unrequested' | 'requesting' | 'accepted';
    entryId: string | null;
  };
};
