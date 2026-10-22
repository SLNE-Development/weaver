#!/usr/bin/env bash
# Repository self-test: no Protoloom name or smoke-test leftover survives outside docs/superpowers,
# and the README and security policy name Weaver's identifiers. Prints REPO OK on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
problem() {
  echo "repo.selftest: $*" >&2
  fail=1
}

# The old name may appear only in the upgrade notes, in the docs test that guards them, and in the self-tests that look for it.
allowed_protoloom=(
  "apps/web/content/docs/self-host/compose.md"
  "apps/web/content/docs/self-host/coolify.md"
  "apps/web/src/lib/docs.test.ts"
  "scripts/e2e/repo.selftest.sh"
  "scripts/e2e/workflows.selftest.sh"
)
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  ok=0
  for allowed in "${allowed_protoloom[@]}"; do [[ "$file" == "$allowed" ]] && ok=1; done
  [[ $ok -eq 1 ]] || problem "names protoloom: $file"
done < <(git grep -il protoloom -- ':!docs/superpowers' || true)

# The smoke test was replaced by scripts/e2e/run.sh. The pattern is split so this file does not match itself.
smoke="$(git grep -n -e 'e2e-''smoke' -e 'seed-''smoke' -- ':!docs/superpowers' || true)"
[[ -z "$smoke" ]] || problem "smoke-test leftovers:"$'\n'"$smoke"

for needle in "scripts/e2e/run.sh" "ghcr.io/slne-development/weaver" "/npm/" "/maven/" "/v2/"; do
  grep -qF -- "$needle" README.md || problem "README.md does not mention $needle"
done
grep -qF "SLNE-Development/weaver/security" SECURITY.md || problem "SECURITY.md has no advisory link"

if [[ $fail -ne 0 ]]; then
  echo "REPO FAILED" >&2
  exit 1
fi
echo "REPO OK"
