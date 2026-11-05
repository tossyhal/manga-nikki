export function isValidMonth(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return Boolean(match && Number(match[1]) > 0);
}

export function daysInMonth(month: string): number {
  const [yearText = '0', monthText = '0'] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (!isValidMonth(month)) return 0;
  if (monthNumber === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

export function moveDateToMonth(value: string, targetMonth: string): string {
  const day = Number(value.slice(-2));
  const lastDay = daysInMonth(targetMonth);
  return `${targetMonth}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function dateParts(value: string) {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}

export function monthTitle(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  return `${year}年${month}月`;
}

export function shiftMonth(value: string, amount: number) {
  const { year, month } = dateParts(`${value}-01`);
  const totalMonths = year * 12 + month - 1 + amount;
  const nextYear = Math.floor(totalMonths / 12);
  if (nextYear < 1 || nextYear > 9999) return value;
  const nextMonth = (totalMonths % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

export function calendarDays(value: string) {
  const { year, month } = dateParts(`${value}-01`);
  const firstDay = new Date(0);
  firstDay.setUTCFullYear(year, month - 1, 1);
  firstDay.setUTCHours(0, 0, 0, 0);
  const offset = firstDay.getUTCDay();
  const count = daysInMonth(value);
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return day < 1 || day > count ? null : `${value}-${String(day).padStart(2, '0')}`;
  });
}
