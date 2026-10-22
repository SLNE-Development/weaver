/** Whether a Maven version string denotes a snapshot (ends with `-SNAPSHOT`). */
export function isSnapshotVersion(version: string): boolean {
  return version.endsWith("-SNAPSHOT");
}

type Token = { kind: "num"; value: bigint } | { kind: "str"; value: string };

const QUALIFIER_ALIASES: Record<string, string> = {
  a: "alpha",
  b: "beta",
  m: "milestone",
  cr: "rc",
  ga: "",
  final: "",
  release: "",
};

const QUALIFIER_ORDER = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const UNKNOWN_RANK = QUALIFIER_ORDER.length;

/** Splits a version on `.`, `-` and digit/letter transitions into numeric and qualifier tokens. */
function tokenize(version: string): Token[] {
  const tokens: Token[] = [];
  for (const part of version.toLowerCase().split(/[.-]/)) {
    for (const piece of part.match(/\d+|\D+/g) ?? [""]) {
      if (/^\d+$/.test(piece)) {
        tokens.push({ kind: "num", value: BigInt(piece) });
      } else {
        tokens.push({ kind: "str", value: QUALIFIER_ALIASES[piece] ?? piece });
      }
    }
  }
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1]!;
    if ((last.kind === "num" && last.value === 0n) || (last.kind === "str" && last.value === "")) tokens.pop();
    else break;
  }
  return tokens;
}

/** Rank of a qualifier; unknown qualifiers sort after every known one. */
function rank(q: string): number {
  const i = QUALIFIER_ORDER.indexOf(q);
  return i < 0 ? UNKNOWN_RANK : i;
}

/** Compares two tokens, where `undefined` is the implicit padding of the shorter version. */
function compareTokens(a: Token | undefined, b: Token | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -compareTokens(b, a);
  if (b === undefined) {
    if (a.kind === "num") return a.value === 0n ? 0 : 1;
    return rank(a.value) - rank("");
  }
  if (a.kind === "num" && b.kind === "num") return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === "num") return 1;
  if (b.kind === "num") return -1;
  const diff = rank(a.value) - rank(b.value);
  if (diff !== 0) return diff;
  if (rank(a.value) === UNKNOWN_RANK) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  return 0;
}

/**
 * Orders two Maven versions like Maven's ComparableVersion: negative when `a` is older than `b`,
 * zero when equivalent, positive when `a` is newer.
 */
export function compareMavenVersions(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const c = compareTokens(ta[i], tb[i]);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}
