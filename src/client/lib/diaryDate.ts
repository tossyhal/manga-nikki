const monthDayFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'UTC',
  month: 'long',
  day: 'numeric',
});
const weekdayFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'UTC',
  weekday: 'long',
});

export function formatDiaryDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '日付を選択';
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date)
    return '日付を選択';
  const monthDay = monthDayFormatter.format(value);
  const weekday = weekdayFormatter.format(value);
  return `${monthDay} ${weekday}`;
}
