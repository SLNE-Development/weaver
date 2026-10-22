#!/usr/bin/env bash
# Checks the GitHub Actions workflows for the rules the e2e plan relies on:
# third-party actions pinned to commit SHAs (reusing only the pins already in ci.yml/release.yml),
# the e2e reusable workflow wired into ci.yml, nightly.yml and release.yml, and no old product name.
# Prints "WORKFLOWS OK" on success; exits non-zero with the failed checks otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WF=.github/workflows
errors=0
fail() {
  echo "FAIL: $*" >&2
  errors=$((errors + 1))
}

for f in "$WF/e2e.yml" "$WF/nightly.yml" "$WF/ci.yml" "$WF/release.yml"; do
  [ -f "$f" ] || fail "$f is missing"
done
[ "$errors" -eq 0 ] || { echo "workflows self-test failed ($errors)" >&2; exit 1; }

# Every non-local `uses:` is pinned to a full commit SHA with the release in a comment.
while IFS= read -r line; do
  ref="$(sed -E 's/^[^:]+:[0-9]+:[[:space:]-]*uses:[[:space:]]*//' <<<"$line")"
  case "$ref" in
    ./*) continue ;;
  esac
  grep -Eq '@[0-9a-f]{40} # v' <<<"$ref" || fail "unpinned action: $line"
done < <(grep -Hn -E '^[[:space:]-]*uses:' "$WF"/*.yml)

# The new workflows add no action pins beyond those already used by ci.yml and release.yml.
known="$(grep -ho -E 'uses:[[:space:]]*[^ ]+@[0-9a-f]{40}' "$WF/ci.yml" "$WF/release.yml" | sed -E 's/uses:[[:space:]]*//' | sort -u)"
for f in "$WF/e2e.yml" "$WF/nightly.yml"; do
  while IFS= read -r pin; do
    [ -n "$pin" ] || continue
    grep -Fxq "$pin" <<<"$known" || fail "$f uses $pin, which ci.yml/release.yml do not"
  done < <(grep -o -E 'uses:[[:space:]]*[^ ]+@[0-9a-f]{40}' "$f" | sed -E 's/uses:[[:space:]]*//' | sort -u)
done

# No workflow mentions the old product name.
if grep -il protoloom "$WF"/*.yml >/dev/null; then
  fail "protoloom appears in: $(grep -il protoloom "$WF"/*.yml | tr '\n' ' ')"
fi

# Structural checks on the parsed YAML (the yaml package is a dependency of apps/web).
node - "$ROOT" <<'NODE' || errors=$((errors + 1))
const path = require("node:path");
const fs = require("node:fs");
const root = process.argv[2];
let YAML;
try {
  YAML = require(require.resolve("yaml", { paths: [path.join(root, "apps/web")] }));
} catch {
  console.error("FAIL: the yaml package is not installed (run pnpm install)");
  process.exit(1);
}
const load = (name) => YAML.parse(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const callers = (wf) => Object.entries(wf.jobs ?? {}).filter(([, j]) => j.uses === "./.github/workflows/e2e.yml");

const e2e = load("e2e.yml");
const call = e2e.on?.workflow_call;
check(call, "e2e.yml is not a workflow_call workflow");
check(call?.inputs?.upstreams?.default === "local", "e2e.yml input upstreams must default to local");
check(call?.inputs?.large?.type === "boolean", "e2e.yml input large must be a boolean");
for (const s of ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"]) {
  check(call?.secrets?.[s] && call.secrets[s].required === false, `e2e.yml secret ${s} must be optional`);
}
const job = e2e.jobs?.e2e;
check(job, "e2e.yml has no job e2e");
check(job?.strategy?.["fail-fast"] === false, "e2e.yml job e2e must set fail-fast: false");
check(String(job?.strategy?.matrix?.format ?? "").includes("fromJSON"), "e2e.yml matrix.format must come from fromJSON");
check(job?.["timeout-minutes"] === 45, "e2e.yml job e2e must time out after 45 minutes");
const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
check(/scripts\/e2e\/run\.sh/.test(runs), "e2e.yml never runs scripts/e2e/run.sh");

const ci = load("ci.yml");
const ciCalls = callers(ci);
check(ciCalls.length === 1, "ci.yml must have exactly one job using ./.github/workflows/e2e.yml");
check(ciCalls[0]?.[1]?.with?.upstreams === "local", "ci.yml e2e job must use upstreams: local");

const nightly = load("nightly.yml");
check(nightly.on && "schedule" in nightly.on, "nightly.yml has no schedule trigger");
check(nightly.on && "workflow_dispatch" in nightly.on, "nightly.yml has no workflow_dispatch trigger");
const nightlyCalls = callers(nightly);
check(nightlyCalls.some(([, j]) => j.with?.upstreams === "real"), "nightly.yml must call e2e.yml with upstreams: real");

const release = load("release.yml");
const releaseCalls = callers(release);
check(releaseCalls.length === 1, "release.yml must have exactly one job using ./.github/workflows/e2e.yml");
const e2eJobName = releaseCalls[0]?.[0];
check(asArray(release.jobs?.image?.needs).includes(e2eJobName ?? "e2e"), "release.yml image.needs must contain the e2e job");
check((release.jobs?.image?.steps ?? []).some((s) => String(s.with?.tags ?? "").includes("ghcr.io/slne-development/weaver:latest")),
  "release.yml image must push ghcr.io/slne-development/weaver:latest");

if (problems.length) {
  for (const p of problems) console.error("FAIL: " + p);
  process.exit(1);
}
NODE

if [ "$errors" -ne 0 ]; then
  echo "workflows self-test failed ($errors)" >&2
  exit 1
fi
echo "WORKFLOWS OK"
