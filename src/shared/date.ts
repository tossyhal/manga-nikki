const jstDateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });

export const jstToday = () => jstDateFormatter.format(new Date());
