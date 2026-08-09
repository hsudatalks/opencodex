export const SINGAPORE_TIME_ZONE = "Asia/Singapore";
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Format an absolute instant as the value expected by a datetime-local input in Singapore. */
export function toSingaporeDateTimeInput(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Date(value + SINGAPORE_OFFSET_MS).toISOString().slice(0, 16);
}

/** Parse a timezone-free form value explicitly as Singapore time (UTC+08:00). */
export function fromSingaporeDateTimeInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return null;
  const parsed = Date.parse(`${trimmed}:00+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function singaporeDateKey(value: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: SINGAPORE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
