/** The lengths of history the stats pages offer, in days, with their labels. */
export const RANGE_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

/** One of the offered range lengths. */
export type RangeDays = (typeof RANGE_OPTIONS)[number]["days"];

/** The range length a `?days=` query value stands for; 30 for anything missing or not offered. */
export function parseDays(raw: string | string[] | undefined): RangeDays {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return RANGE_OPTIONS.find((option) => option.days === value)?.days ?? 30;
}

/** A `YYYY-MM-DD` UTC day as `Oct 21, 2026`, in UTC so the date never shifts with the viewer's time zone. */
export function formatUtcDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** A hit rate (0..1) as a whole percent such as `50%`; a dash without any lookup. */
export function formatPercent(rate: number | null): string {
  return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}
