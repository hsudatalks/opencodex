import { describe, expect, test } from "bun:test";
import { formatCreditDate, formatCreditDateTime } from "../src/intl-formatters";

describe("credit date formatting", () => {
  test("keeps the compact date format for grant dates", () => {
    const iso = "2026-07-31T12:34:56Z";
    const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

    expect(formatCreditDate(iso, "de-DE")).not.toContain(time);
  });

  test("formats expiration dates in Singapore time", () => {
    const iso = "2026-07-31T12:34:56Z";
    expect(formatCreditDateTime(iso, "de-DE")).toContain("20:34");
    expect(formatCreditDateTime(iso, "de-DE")).not.toContain("12:34");
    expect(formatCreditDateTime(iso, "de-DE")).not.toBe("—");
  });

  test("handles invalid dates consistently", () => {
    expect(formatCreditDateTime("invalid")).toBe("—");
  });
});
