/** Splits a version into its numeric core and its prerelease identifiers (build metadata is dropped). */
function parse(version: string): { core: number[]; pre: string[] } {
  const noBuild = version.split("+")[0]!;
  const dash = noBuild.indexOf("-");
  const core = (dash < 0 ? noBuild : noBuild.slice(0, dash)).split(".").map(Number);
  const pre = dash < 0 ? [] : noBuild.slice(dash + 1).split(".");
  return { core, pre };
}

/** Compares two prerelease identifiers: numeric ones numerically and below alphanumeric ones, those by ASCII order. */
function compareIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two semantic versions by SemVer 2.0 precedence: negative when `a` is lower, positive when higher, 0 when
 * equal (build metadata is ignored; a prerelease is lower than its release).
 */
export function compareSemver(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const c = compareIdentifier(x.pre[i]!, y.pre[i]!);
    if (c !== 0) return c;
  }
  return Math.sign(x.pre.length - y.pre.length);
}
