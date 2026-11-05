import type { ReactNode } from 'react';

export function DiaryBodyField({
  id,
  countId,
  value,
  onChange,
  placeholder,
  descriptionId,
  footer,
}: {
  id: string;
  countId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  descriptionId?: string;
  footer?: ReactNode;
}) {
  return (
    <div className="entry-editor-card">
      <label className="entry-editor-title" htmlFor={id}>
        今日はどんな日だった？
      </label>
      <textarea
        id={id}
        rows={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required
        aria-describedby={descriptionId ? `${countId} ${descriptionId}` : countId}
      />
      <div className="entry-editor-footer">
        {footer ?? <span />}
        <p id={countId} className="character-count">
          {[...value.trim()].length} / 1,000
        </p>
      </div>
    </div>
  );
}
