export function schedulePeriod(now, { timeZone = 'America/New_York', hour = 10 } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const last = new Date(Date.UTC(year, month, 0));
  const lastWednesday = last.getUTCDate() - (last.getUTCDay() - 3 + 7) % 7;
  return day > lastWednesday || (day === lastWednesday && Number(parts.hour) >= hour) ? `${parts.year}-${parts.month}` : null;
}

// Catch up within each review month; outside those months only an already-persisted due review remains pending.
export function seasonalPeriod(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  if (![1, 5, 7].includes(month)) return null;
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(year, month, 0));
  const dueDay = month === 7 ? last.getUTCDate() - (last.getUTCDay() - 3 + 7) % 7 : 8 + (3 - firstWeekday + 7) % 7;
  return day > dueDay || (day === dueDay && Number(parts.hour) >= 10) ? `${parts.year}-${parts.month}` : null;
}
