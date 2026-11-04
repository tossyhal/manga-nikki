export type IconName =
  | 'home'
  | 'plus'
  | 'calendar'
  | 'chevron-left'
  | 'chevron-right'
  | 'back'
  | 'more'
  | 'clock'
  | 'check'
  | 'alert'
  | 'trash'
  | 'edit'
  | 'book'
  | 'wifi-off'
  | 'settings'
  | 'close';

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <path d="m3.5 10 8.5-7 8.5 7v9.5a1 1 0 0 1-1 1h-5.2v-6.2H9.7v6.2H4.5a1 1 0 0 1-1-1z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="16" rx="2" />
        <path d="M7.5 3v4M16.5 3v4M3.5 10h17" />
      </>
    ),
    'chevron-left': <path d="m15 18-6-6 6-6" />,
    'chevron-right': <path d="m9 18 6-6-6-6" />,
    back: <path d="m15 18-6-6 6-6M9.5 12H20" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
    check: <path d="m5 12 4.5 4.5L19 7" />,
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5M12 16h.01" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />
      </>
    ),
    edit: <path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5zM13.5 7l3.5 3.5" />,
    book: <path d="M12 6c-2.3-1.7-5.5-2-8-1.5v14c2.8-.5 5.9-.1 8 1.5m0-14c2.3-1.7 5.5-2 8-1.5v14c-2.8-.5-5.9-.1-8 1.5m0-14v14" />,
    'wifi-off': <path d="M3 8.5a14 14 0 0 1 15.5-.8M6.5 12a9 9 0 0 1 9-.9M10 15.5a4 4 0 0 1 3.5-.2M3 3l18 18M12 20h.01" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z" transform="translate(-1 -1) scale(1.08)" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };

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
      strokeLinejoin="round"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
