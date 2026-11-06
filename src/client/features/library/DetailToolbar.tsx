import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../app/Icon';

export function DetailToolbar({
  backTo,
  title,
  summary,
  statusView,
  pending,
  busy,
  onEdit,
  onDelete,
}: {
  backTo: string;
  title: string;
  summary: string;
  statusView: boolean;
  pending: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerInsideRef = useRef(false);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuAnchorRef.current?.contains(target)) setMenuOpen(false);
    };
    const clearPointerInside = () => {
      pointerInsideRef.current = false;
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('pointerup', clearPointerInside, true);
    document.addEventListener('pointercancel', clearPointerInside, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('pointerup', clearPointerInside, true);
      document.removeEventListener('pointercancel', clearPointerInside, true);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);

  return (
    <header className="detail-toolbar">
      <Link className="icon-button" to={backTo} aria-label="記録の一覧へ戻る">
        <Icon name="back" />
      </Link>
      <div className="detail-title-group">
        <h1 className={`detail-title${statusView ? ' detail-state-title' : ''}`}>{title}</h1>
        {statusView && <p className="detail-state-summary">{summary}</p>}
      </div>
      <div
        ref={menuAnchorRef}
        className="detail-menu-anchor"
        onPointerDownCapture={() => {
          pointerInsideRef.current = true;
        }}
        onClickCapture={() => {
          pointerInsideRef.current = false;
        }}
        onBlurCapture={(event) => {
          if (pointerInsideRef.current) return;
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget))
            setMenuOpen(false);
        }}
      >
        <button
          ref={menuTriggerRef}
          className="icon-button"
          type="button"
          aria-label="その他の操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            className="detail-menu"
            role="menu"
            aria-label="記録の操作"
            tabIndex={-1}
            onKeyDown={(event) => {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'Escape') {
                event.preventDefault();
                setMenuOpen(false);
                menuTriggerRef.current?.focus();
              } else if (event.key === 'ArrowDown' && items.length > 0) {
                event.preventDefault();
                items[(currentIndex + 1) % items.length]?.focus();
              } else if (event.key === 'ArrowUp' && items.length > 0) {
                event.preventDefault();
                items[(currentIndex - 1 + items.length) % items.length]?.focus();
              } else if (event.key === 'Home' && items.length > 0) {
                event.preventDefault();
                items[0]?.focus();
              } else if (event.key === 'End' && items.length > 0) {
                event.preventDefault();
                items.at(-1)?.focus();
              }
            }}
          >
            {!pending && (
              <button
                className="detail-menu-item"
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              >
                <Icon name="edit" size={19} />
                <span>日記を編集</span>
              </button>
            )}
            <button
              className="detail-menu-item"
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Icon name="trash" size={19} />
              <span>日記を削除</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
