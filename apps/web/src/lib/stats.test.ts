import { describe, expect, it } from "vitest";
import { formatPercent, formatUtcDay, parseDays } from "./stats";

describe("parseDays", () => {
  it("accepts the offered lengths", () => {
    expect(parseDays("7")).toBe(7);
    expect(parseDays("365")).toBe(365);
  });

  it("falls back to 30 days", () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays("14")).toBe(30);
    expect(parseDays("abc")).toBe(30);
  });

  it("uses the first of repeated values", () => {
    expect(parseDays(["90", "7"])).toBe(90);
  });
});

describe("formatPercent", () => {
  it("rounds to a whole percent", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(2 / 3)).toBe("67%");
  });

  it("shows a dash without lookups", () => {
    expect(formatPercent(null)).toBe("-");
  });
});

describe("formatUtcDay", () => {
  it("keeps the UTC calendar day", () => {
    expect(formatUtcDay("2026-10-21")).toBe("Oct 21, 2026");
  });
});
