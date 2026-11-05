import { useRef, type KeyboardEvent } from 'react';
import { Icon } from '../../app/Icon';
import type { LibraryView } from './librarySearch';

function ListViewIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      focusable="false"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4" cy="6" r=".6" fill="currentColor" />
      <circle cx="4" cy="12" r=".6" fill="currentColor" />
      <circle cx="4" cy="18" r=".6" fill="currentColor" />
    </svg>
  );
}

export function LibraryViewTabs({
  view,
  onChange,
}: {
  view: LibraryView;
  onChange: (view: LibraryView) => void;
}) {
  const calendarTabRef = useRef<HTMLButtonElement>(null);
  const listTabRef = useRef<HTMLButtonElement>(null);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextView: LibraryView | null = null;
    const currentView = event.currentTarget.id === 'library-calendar-tab' ? 'calendar' : 'list';
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextView = currentView === 'calendar' ? 'list' : 'calendar';
    } else if (event.key === 'Home') {
      nextView = 'calendar';
    } else if (event.key === 'End') {
      nextView = 'list';
    }
    if (!nextView) return;
    event.preventDefault();
    onChange(nextView);
    (nextView === 'calendar' ? calendarTabRef : listTabRef).current?.focus();
  }

  return (
    <div className="library-view-tabs" role="tablist" aria-label="記録の表示方法">
      <button
        ref={calendarTabRef}
        type="button"
        role="tab"
        id="library-calendar-tab"
        className="library-view-tab"
        aria-controls="library-calendar-panel"
        aria-selected={view === 'calendar'}
        tabIndex={view === 'calendar' ? 0 : -1}
        onClick={() => onChange('calendar')}
        onKeyDown={onTabKeyDown}
      >
        <Icon name="calendar" size={17} />
        <span>カレンダー</span>
      </button>
      <button
        ref={listTabRef}
        type="button"
        role="tab"
        id="library-list-tab"
        className="library-view-tab"
        aria-controls="library-list-panel"
        aria-selected={view === 'list'}
        tabIndex={view === 'list' ? 0 : -1}
        onClick={() => onChange('list')}
        onKeyDown={onTabKeyDown}
      >
        <ListViewIcon />
        <span>リスト</span>
      </button>
    </div>
  );
}
