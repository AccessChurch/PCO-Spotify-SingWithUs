export function schedulePeriod(now, { timeZone = 'America/New_York', hour = 10 } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const last = new Date(Date.UTC(year, month, 0));
  const lastWednesday = last.getUTCDate() - (last.getUTCDay() - 3 + 7) % 7;
  return day > lastWednesday || (day === lastWednesday && Number(parts.hour) >= hour) ? `${parts.year}-${parts.month}` : null;
}
