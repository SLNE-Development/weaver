import type { PathRules } from "./config.js";

/**
 * Whether `subject` matches `pattern` as a whole, where `*` matches any run of characters (dots and
 * slashes too) and every other character matches itself. Greedy two-pointer matching that only
 * backtracks to the most recent `*`: O(pattern × subject) in the worst case, never exponential, so
 * client-controlled subjects cannot cause catastrophic backtracking.
 */
export function globMatches(pattern: string, subject: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < subject.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === subject[s]) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Glob match where `*` matches any run of characters; empty allow = allow all; deny wins. */
export function matchesRules(rules: PathRules, subject: string): boolean {
  if (rules.deny.some((p) => globMatches(p, subject))) return false;
  return rules.allow.length === 0 || rules.allow.some((p) => globMatches(p, subject));
}
