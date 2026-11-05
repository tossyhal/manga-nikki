export function PageControls({
  page,
  canGoPrevious,
  canGoNext,
  busy,
  label,
  onPrevious,
  onNext,
}: {
  page: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  busy: boolean;
  label: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="library-page-controls" aria-label={label}>
      <button type="button" disabled={!canGoPrevious || busy} onClick={onPrevious}>
        前へ
      </button>
      <span aria-live="polite">{page}ページ目</span>
      <button type="button" disabled={!canGoNext || busy} onClick={onNext}>
        次へ
      </button>
    </nav>
  );
}
