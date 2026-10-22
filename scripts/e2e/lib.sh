# Shared helpers of the e2e harness, sourced by run.sh and every format script (POSIX bash).
#
# Expects ROOT (repository root), WORK (scratch dir) and, once the stack exists, ENV_FILE,
# E2E_PROJECT and UPSTREAMS (local|real). FORMAT names the running format script for `step`.
# Every assertion fails through `fail "<step>: <why>"`, which dumps the stack's recent logs.

# Prints the failure, the last compose logs (when a stack exists) and exits 1.
fail() {
  echo "E2E FAILED: $*" >&2
  if [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ]; then
    echo "--- compose logs ---" >&2
    e2e_compose logs --tail=120 >&2 || true
  fi
  exit 1
}

# docker compose over docker-compose.prod.yml plus the e2e override; local mode adds the stand-ins.
e2e_compose() {
  local profile=()
  [ "${UPSTREAMS:-local}" = "local" ] && profile=(--profile local)
  docker compose -p "${E2E_PROJECT:-weaver-e2e}" --env-file "$ENV_FILE" \
    -f "$ROOT/docker-compose.prod.yml" -f "$ROOT/scripts/e2e/compose.e2e.yml" "${profile[@]}" "$@"
}

# Prints "==> <format>: <title>".
step() {
  echo "==> ${FORMAT:-e2e}: $*"
}

# Creates a new empty directory under $WORK and echoes its path.
fresh_dir() {
  local dir
  dir="$(mktemp -d "$WORK/${1:-dir}.XXXXXX")" || fail "fresh_dir: cannot create $1 under $WORK"
  echo "$dir"
}

# Requests <method> <url> with curl (extra curl args allowed) and asserts the status code.
# The body lands in $WORK/last.body, the headers in $WORK/last.headers.
expect_status() {
  local want="$1" method="$2" url="$3" got verb
  shift 3
  # `-X HEAD` would make curl wait for a body the server never sends; --head does not.
  verb=(-X "$method")
  [ "$method" = "HEAD" ] && verb=(--head)
  got="$(curl -sS -o "$WORK/last.body" -D "$WORK/last.headers" -w '%{http_code}' "${verb[@]}" "$@" "$url")" ||
    fail "$method $url: curl failed"
  [ "$got" = "$want" ] || fail "$method $url: expected $want, got $got: $(head -c 600 "$WORK/last.body")"
}

# Asserts that a header of the last expect_status whose name matches <name-regex> has a value matching <value-regex>.
expect_header() {
  tr -d '\r' <"$WORK/last.headers" | grep -iE "^($1):" | sed 's/^[^:]*:[[:space:]]*//' | grep -qE -- "$2" ||
    fail "header $1: no value matches '$2' in: $(tr -d '\r' <"$WORK/last.headers" | grep -iE "^($1):" || echo '(missing)')"
}

# Runs <cmd...>; it must exit non-zero and its combined output must match <regex>.
expect_fail() {
  local regex="$1" out
  shift
  if out="$("$@" 2>&1)"; then
    fail "expected failure of '$*', but it succeeded: $(printf '%s' "$out" | tail -n 20)"
  fi
  printf '%s' "$out" | grep -qE -- "$regex" ||
    fail "'$*' failed without matching '$regex': $(printf '%s' "$out" | tail -n 20)"
}

# Asserts that <file> has a line matching <regex>.
expect_contains() {
  [ -f "$2" ] || fail "expect_contains: $2 does not exist"
  grep -qE -- "$1" "$2" || fail "$2 does not match '$1': $(head -c 600 "$2")"
}

# Runs <query> with psql -tA on the main database and echoes the result.
sql() {
  e2e_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-weaver}" -d "${POSTGRES_DB:-weaver}" -tA -c "$1" |
    tr -d '\r' || fail "sql: $1"
}

# Echoes the number of asset rows of <repo>, optionally only those of <origin> (hosted|cache).
asset_count() {
  local where="r.name = '$1'"
  [ -n "${2:-}" ] && where="$where AND a.origin = '$2'"
  sql "SELECT count(*) FROM asset a JOIN repository r ON r.id = a.repository_id WHERE $where"
}

# Echoes the distinct store ids of <repo>'s assets, sorted and comma-separated (empty without assets).
asset_stores() {
  sql "SELECT coalesce(string_agg(DISTINCT a.store, ',' ORDER BY a.store), '') FROM asset a JOIN repository r ON r.id = a.repository_id WHERE r.name = '$1'"
}

# Echoes the number of usage_event rows of <repo> with cache result <hit|miss|bypass|stale>.
cache_events() {
  sql "SELECT count(*) FROM usage_event e JOIN repository r ON r.id = e.repository_id WHERE r.name = '$1' AND e.cache = '$2'"
}

# The stand-in compose service of <format> (local mode).
stand_in() {
  case "$1" in
    proto) echo upstream ;;
    maven) echo reposilite ;;
    npm) echo verdaccio ;;
    docker) echo registry ;;
    *) fail "stand_in: unknown format $1" ;;
  esac
}

# Makes <format>'s upstream unreachable: stops its stand-in (local) or sets its mirrors offline (real).
upstream_down() {
  if [ "${UPSTREAMS:-local}" = "local" ]; then
    e2e_compose stop "$(stand_in "$1")" >/dev/null 2>&1 || fail "upstream_down $1: compose stop failed"
  else
    sql "UPDATE repository SET config = jsonb_set(config, '{offline}', 'true') WHERE format = '$1' AND kind = 'mirror'" >/dev/null
  fi
}

# Brings <format>'s upstream back and, in local mode, waits until its stand-in is healthy again.
upstream_up() {
  if [ "${UPSTREAMS:-local}" = "local" ]; then
    e2e_compose up -d --wait --wait-timeout 120 "$(stand_in "$1")" >/dev/null 2>&1 ||
      fail "upstream_up $1: $(stand_in "$1") did not become healthy"
  else
    sql "UPDATE repository SET config = jsonb_set(config, '{offline}', 'false') WHERE format = '$1' AND kind = 'mirror'" >/dev/null
  fi
}
