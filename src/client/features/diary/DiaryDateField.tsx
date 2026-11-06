import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../app/Icon';
import {
  calendarDays,
  dateParts,
  daysInMonth,
  moveDateToMonth,
  monthTitle,
  shiftMonth,
} from '../library/libraryCalendar';
import { formatDiaryDate } from '../../lib/diaryDate';
import { useJstToday } from '../../lib/useJstToday';
import './DiaryDateField.css';

const weekDays = ['日', '月', '火', '水', '木', '金', '土'];

function addDays(value: string, amount: number) {
  const { year, month, day } = dateParts(value);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + amount);
  const nextYear = date.getUTCFullYear();
  if (nextYear < 1 || nextYear > 9999) return value;
  return `${String(nextYear).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function activeDateForMonth(month: string, value: string, today: string) {
  if (value.slice(0, 7) === month && value <= today) return value;
  if (today.slice(0, 7) === month) return today;
  if (month < today.slice(0, 7)) {
    return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  }
  return null;
}

export function DiaryDateField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const today = useJstToday();
  const dialogId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dayButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const wasOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => value.slice(0, 7));
  const [activeDate, setActiveDate] = useState<string | null>(value);
  const days = calendarDays(visibleMonth);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (disabled || triggerRef.current?.matches(':disabled')) {
        setOpen(false);
        return;
      }
      if (!dialog.open) dialog.showModal();
      wasOpenRef.current = true;
      const activeButton = activeDate ? dayButtonRefs.current.get(activeDate) : null;
      if (activeButton && !activeButton.disabled) activeButton.focus();
      else closeButtonRef.current?.focus();
      return;
    }

    if (dialog.open) dialog.close();
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [activeDate, disabled, open, visibleMonth]);

  function openCalendar() {
    if (disabled || triggerRef.current?.matches(':disabled')) return;
    const month = value.slice(0, 7);
    setVisibleMonth(month);
    setActiveDate(activeDateForMonth(month, value, today));
    setOpen(true);
  }

  function closeCalendar() {
    setOpen(false);
  }

  function selectDate(date: string) {
    if (date > today || disabled || triggerRef.current?.matches(':disabled')) return;
    onChange(date);
    setOpen(false);
  }

  function changeMonth(amount: number) {
    const nextMonth = shiftMonth(visibleMonth, amount);
    if (nextMonth === visibleMonth || nextMonth > today.slice(0, 7)) return;
    const currentDate = activeDate ?? value;
    const nextDate = moveDateToMonth(currentDate, nextMonth);
    setVisibleMonth(nextMonth);
    setActiveDate(nextDate <= today ? nextDate : activeDateForMonth(nextMonth, value, today));
  }

  function focusDate(date: string) {
    if (date > today) return;
    setVisibleMonth(date.slice(0, 7));
    setActiveDate(date);
  }

  function handleDayKeyDown(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    let nextDate: string | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        nextDate = addDays(date, -1);
        break;
      case 'ArrowRight':
        nextDate = addDays(date, 1);
        break;
      case 'ArrowUp':
        nextDate = addDays(date, -7);
        break;
      case 'ArrowDown':
        nextDate = addDays(date, 7);
        break;
      case 'Home':
        nextDate = addDays(date, -weekday);
        break;
      case 'End':
        nextDate = addDays(date, 6 - weekday);
        break;
      case 'PageUp':
      case 'PageDown': {
        const month = shiftMonth(
          date.slice(0, 7),
          (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
        );
        if (month <= today.slice(0, 7)) nextDate = moveDateToMonth(date, month);
        break;
      }
      default:
        return;
    }

    event.preventDefault();
    if (nextDate && nextDate <= today) focusDate(nextDate);
  }

  const canGoToPreviousMonth = shiftMonth(visibleMonth, -1) !== visibleMonth;
  const canGoToNextMonth = visibleMonth < today.slice(0, 7);

  return (
    <div className="date-control diary-date-field">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label="日付"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        className="date-display diary-date-trigger"
        onClick={openCalendar}
      >
        <time dateTime={value}>{formatDiaryDate(value)}</time>
        <Icon name="calendar" size={20} />
      </button>

      <dialog
        ref={dialogRef}
        id={dialogId}
        className="diary-date-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          closeCalendar();
        }}
      >
        <div className="diary-date-dialog__content">
          <div className="diary-date-dialog__header">
            <button
              type="button"
              className="diary-date-dialog__month-button"
              aria-label="前の月"
              disabled={!canGoToPreviousMonth}
              onClick={() => changeMonth(-1)}
            >
              <Icon name="chevron-left" size={22} />
            </button>
            <h2 id={titleId}>{monthTitle(visibleMonth)}</h2>
            <button
              type="button"
              className="diary-date-dialog__month-button"
              aria-label="次の月"
              disabled={!canGoToNextMonth}
              onClick={() => changeMonth(1)}
            >
              <Icon name="chevron-right" size={22} />
            </button>
          </div>

          <table className="diary-date-calendar" aria-label={`${monthTitle(visibleMonth)}の日付`}>
            <thead>
              <tr>
                {weekDays.map((weekDay) => (
                  <th key={weekDay} scope="col" aria-label={`${weekDay}曜日`}>
                    {weekDay}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }, (_, weekIndex) => (
                <tr key={`${visibleMonth}-week-${weekIndex}`}>
                  {days.slice(weekIndex * 7, weekIndex * 7 + 7).map((date, dayIndex) => {
                    if (!date) return <td key={`${weekIndex}-${dayIndex}`} aria-hidden="true" />;
                    const { year, month, day } = dateParts(date);
                    const isFuture = date > today;

                    return (
                      <td key={date}>
                        <button
                          ref={(button) => {
                            if (button) dayButtonRefs.current.set(date, button);
                            else dayButtonRefs.current.delete(date);
                          }}
                          type="button"
                          className="diary-date-calendar__day"
                          aria-label={`${year}年${month}月${day}日`}
                          aria-pressed={date === value}
                          aria-current={date === today ? 'date' : undefined}
                          disabled={isFuture}
                          tabIndex={date === activeDate && !isFuture ? 0 : -1}
                          onFocus={() => setActiveDate(date)}
                          onClick={() => selectDate(date)}
                          onKeyDown={(event) => handleDayKeyDown(event, date)}
                        >
                          {day}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="diary-date-dialog__footer">
            <button
              type="button"
              className="diary-date-dialog__today-button"
              onClick={() => selectDate(today)}
            >
              今日
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="diary-date-dialog__close-button"
              onClick={closeCalendar}
            >
              閉じる
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
