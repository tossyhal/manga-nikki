import { formatDiaryDate } from '../../lib/diaryDate';
import { Icon } from '../../app/Icon';
import { useJstToday } from '../../lib/useJstToday';

export function DiaryDateField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const today = useJstToday();

  return (
    <div className="date-control">
      <label className="date-display" htmlFor={id}>
        <time dateTime={value}>{formatDiaryDate(value)}</time>
        <Icon name="calendar" size={20} />
      </label>
      <input
        id={id}
        aria-label="日付"
        className="date-picker-input"
        type="date"
        value={value}
        max={today}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        required
      />
    </div>
  );
}
