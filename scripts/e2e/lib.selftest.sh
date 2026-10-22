#!/usr/bin/env bash
# Self-test of scripts/e2e/lib.sh against a throwaway `python3 -m http.server`; prints LIB OK.
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -m "$WORK")"
  ROOT="$(cygpath -m "$ROOT")"
fi
unset ENV_FILE
FORMAT=selftest
PYTHON="${PYTHON:-python3}"
PORT="${LIB_SELFTEST_PORT:-38917}"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# shellcheck source=lib.sh
. "$HERE/lib.sh"

bad() {
  echo "LIB SELFTEST FAILED: $*" >&2
  exit 1
}

mkdir -p "$WORK/www"
echo hello >"$WORK/www/index.html"
"$PYTHON" -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/www" >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

step "expect_status passes on the expected code"
(expect_status 200 GET "http://127.0.0.1:$PORT/") 2>/dev/null || bad "expect_status 200 on / failed"
(expect_header 'content-type' 'text/html') 2>/dev/null || bad "expect_header content-type text/html failed"
(expect_header 'content-type' 'image/png') 2>/dev/null && bad "expect_header matched a wrong value"

step "expect_status fails on a 404"
(expect_status 200 GET "http://127.0.0.1:$PORT/missing") 2>/dev/null && bad "expect_status 200 passed on a 404"

step "expect_fail fails when the output lacks the pattern"
(expect_fail 'boom' false) 2>/dev/null && bad "expect_fail 'boom' false passed"

step "expect_fail fails when the command succeeds"
(expect_fail 'boom' sh -c 'echo boom') 2>/dev/null && bad "expect_fail passed on a succeeding command"

step "expect_fail passes on a failing command with matching output"
(expect_fail 'boom' sh -c 'echo boom; exit 1') || bad "expect_fail 'boom' on 'echo boom; exit 1' failed"

step "expect_contains"
(expect_contains '^hel+o$' "$WORK/www/index.html") || bad "expect_contains missed a matching line"
(expect_contains 'nope' "$WORK/www/index.html") 2>/dev/null && bad "expect_contains matched a missing pattern"

step "fresh_dir gives a new empty dir every time"
a="$(fresh_dir a)"
b="$(fresh_dir a)"
[ "$a" != "$b" ] || bad "fresh_dir a returned $a twice"
[ -d "$a" ] && [ -d "$b" ] || bad "fresh_dir did not create directories"
[ -z "$(ls -A "$a")" ] && [ -z "$(ls -A "$b")" ] || bad "fresh_dir directories are not empty"

echo "LIB OK"
