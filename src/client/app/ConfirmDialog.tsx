import { useEffect, useId, useRef } from 'react';
import { Icon, type IconName } from './Icon';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  icon = 'alert',
  destructive = false,
  cancelPrimary = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  icon?: IconName | null;
  destructive?: boolean;
  cancelPrimary?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={`confirm-dialog${icon === null ? ' confirm-dialog--plain' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="confirm-dialog-content">
        {icon !== null && (
          <div className="confirm-dialog-icon">
            <Icon name={icon} size={icon === 'trash' ? 40 : 30} />
          </div>
        )}
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {cancelPrimary ? (
          <>
            <button className="button button-primary" type="button" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              className={destructive ? 'button-text button-text-danger' : 'button-text'}
              type="button"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </>
        ) : (
          <>
            <button
              className={destructive ? 'button button-danger' : 'button button-primary'}
              type="button"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
            <button className="button-text" type="button" onClick={onCancel}>
              {cancelLabel}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
