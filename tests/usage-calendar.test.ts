import { expect, test } from "bun:test";
import { usageCalendarPeriod } from "../src/usage/calendar";

test("Singapore weeks run Monday through Sunday across year boundaries", () => {
  for (const input of ["2025-12-29T00:00:00+08:00", "2026-01-04T23:59:59+08:00"]) {
    expect(usageCalendarPeriod("7d", Date.parse(input))).toEqual({
      start: Date.parse("2025-12-29T00:00:00+08:00"),
      end: Date.parse("2026-01-04T23:59:59.999+08:00"), days: 7, endDate: "2026-01-04",
    });
  }
  expect(usageCalendarPeriod("7d", Date.parse("2026-01-04T16:00:00Z")).endDate).toBe("2026-01-11");
});

test("calendar months cover leap years and navigate without month-end overflow", () => {
  for (const [input, days] of [["2024-02-15", 29], ["2025-02-15", 28], ["2026-04-30", 30], ["2026-03-31", 31]] as const) {
    const period = usageCalendarPeriod("30d", Date.parse(`${input}T12:00:00+08:00`));
    expect(period.days).toBe(days);
    expect(period.start).toBe(Date.parse(`${input.slice(0, 7)}-01T00:00:00+08:00`));
  }
  const now = Date.parse("2026-03-31T12:00:00+08:00");
  expect(usageCalendarPeriod("30d", now, -1).endDate).toBe("2026-02-28");
  expect(usageCalendarPeriod("30d", now, -3).endDate).toBe("2025-12-31");
  expect(usageCalendarPeriod("7d", now, -1).endDate).toBe("2026-03-29");
});
