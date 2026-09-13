const DAY = 86_400_000;
const OFFSET = 8 * 60 * 60 * 1_000;

/** Calendar boundaries in Singapore, independent of the browser/server timezone. */
export function usageCalendarPeriod(range: string, now: number, offset = 0) {
  const date = new Date(now + OFFSET);
  date.setUTCHours(0, 0, 0, 0);
  if (range === "7d") {
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + offset * 7);
  } else if (range === "30d") {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + offset);
  } else {
    date.setUTCDate(date.getUTCDate() + offset);
  }
  const start = date.getTime() - OFFSET;
  if (range === "30d") date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + (range === "7d" ? 7 : 1));
  const end = date.getTime() - OFFSET - 1;
  return { start, end, days: Math.round((end + 1 - start) / DAY), endDate: new Date(end + OFFSET).toISOString().slice(0, 10) };
}
