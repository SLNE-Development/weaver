#!/usr/bin/env bash
# End-to-end harness: boots docker-compose.prod.yml plus scripts/e2e/compose.e2e.yml (dual storage,
# a second Weaver as proto upstream, stand-in upstreams), seeds both Weaver instances from JSON specs
# and runs one script per format against them with stock clients. Tears everything down afterwards.
#
#   scripts/e2e/run.sh [--upstreams=local|real] [--keep] [format...]
#
# Formats: platform proto maven npm docker (default: all; docker only on Linux). `--upstreams=real`
# points the mirrors at the public registries (repos.real.json) and allows only maven npm docker.
# `--keep` leaves the stack and $WORK in place for debugging.
#
# Environment: E2E_PORT (default 3100) is Weaver's host port; E2E_PROJECT (default weaver-e2e) the
# compose project, so several checkouts can run side by side (with distinct E2E_*_PORT values too);
# E2E_IMAGE names a prebuilt image to use instead of building weaver:e2e (CI loads one).
#
# Requires: docker (compose v2), node, curl, and `pnpm install && pnpm build` already run (esbuild for
# the seed bundle, packages/cli/dist). Each format script is sourced in a subshell and prints
# `E2E <format> OK`; this script prints `E2E OK` when all passed.
set -euo pipefail

# Git Bash on Windows would rewrite container paths such as /tmp/... into Windows paths.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UPSTREAMS=local
KEEP=0
FORMATS=()
for arg in "$@"; do
  case "$arg" in
    --upstreams=local | --upstreams=real) UPSTREAMS="${arg#--upstreams=}" ;;
    --upstreams=*) echo "run.sh: --upstreams must be local or real" >&2; exit 2 ;;
    --keep) KEEP=1 ;;
    platform | proto | maven | npm | docker) FORMATS+=("$arg") ;;
    *) echo "run.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done

LINUX=0
[ "$(uname -s)" = "Linux" ] && LINUX=1
if [ "${#FORMATS[@]}" -eq 0 ]; then
  if [ "$UPSTREAMS" = "real" ]; then
    FORMATS=(maven npm docker)
  else
    FORMATS=(platform proto maven npm docker)
  fi
  if [ "$LINUX" -eq 0 ]; then
    echo "run.sh: skipping docker (docker e2e needs Linux (host networking))" >&2
    FORMATS=("${FORMATS[@]/docker/}")
  fi
fi
for f in "${FORMATS[@]}"; do
  [ -z "$f" ] && continue
  if [ "$UPSTREAMS" = "real" ]; then
    case "$f" in maven | npm | docker) ;; *) echo "run.sh: $f has no real upstream" >&2; exit 2 ;; esac
  fi
  if [ "$f" = "docker" ] && [ "$LINUX" -eq 0 ]; then
    echo "run.sh: docker e2e needs Linux (host networking)" >&2
    exit 2
  fi
done
SPEC="$ROOT/scripts/e2e/repos.$UPSTREAMS.json"
[ -f "$SPEC" ] || { echo "run.sh: missing seed spec $SPEC" >&2; exit 2; }

E2E_PORT="${E2E_PORT:-3100}"
E2E_PROJECT="${E2E_PROJECT:-weaver-e2e}"
E2E_UPSTREAM_PORT="${E2E_UPSTREAM_PORT:-3200}"
URL="http://localhost:${E2E_PORT}"
HOST="localhost:${E2E_PORT}"
UPSTREAM_URL="http://localhost:${E2E_UPSTREAM_PORT}"
WORK="$(mktemp -d)"
# With path conversion off, hand Windows binaries (docker, node, curl) a C:/... path on Git Bash.
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -m "$WORK")"
  ROOT="$(cygpath -m "$ROOT")"
  SPEC="$(cygpath -m "$SPEC")"
fi
ENV_FILE="$WORK/e2e.env"
export ROOT WORK ENV_FILE E2E_PROJECT E2E_PORT UPSTREAMS URL HOST UPSTREAM_URL

# shellcheck source=lib.sh
. "$ROOT/scripts/e2e/lib.sh"

cleanup() {
  local rc=$?
  if [ "$KEEP" -eq 1 ]; then
    echo "run.sh: --keep: stack ${E2E_PROJECT} and ${WORK} left in place" >&2
  else
    if [ -f "$ENV_FILE" ]; then
      e2e_compose --profile docker down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"
  fi
  exit "$rc"
}
trap cleanup EXIT

rand() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"; }

{
  echo "WEAVER_IMAGE=${E2E_IMAGE:-weaver:e2e}"
  echo "POSTGRES_PASSWORD=$(rand)"
  echo "BETTER_AUTH_SECRET=$(rand)"
  echo "BETTER_AUTH_URL=${URL}"
  echo "APP_PORT=${E2E_PORT}"
  echo "UPSTREAM_URL=${UPSTREAM_URL}"
  echo "E2E_UPSTREAM_PORT=${E2E_UPSTREAM_PORT}"
  echo "E2E_REGISTRY_PORT=${E2E_REGISTRY_PORT:-5000}"
  echo "E2E_VERDACCIO_PORT=${E2E_VERDACCIO_PORT:-4873}"
  echo "E2E_REPOSILITE_PORT=${E2E_REPOSILITE_PORT:-8081}"
  echo "S3_ACCESS_KEY_ID=e2e$(rand | head -c 16)"
  echo "S3_SECRET_ACCESS_KEY=$(rand)"
  echo "GITHUB_CLIENT_ID=e2e-client-id"
  echo "GITHUB_CLIENT_SECRET=e2e-client-secret"
  grep -E '^[A-Z_]+=' "$ROOT/scripts/e2e/versions.env"
} >"$ENV_FILE"
set -a
# shellcheck source=versions.env
. "$ROOT/scripts/e2e/versions.env"
set +a

FORMAT=harness
step "start the stack (${E2E_PROJECT}, ${URL}, upstreams ${UPSTREAMS})"
if [ -z "${E2E_IMAGE:-}" ]; then
  e2e_compose build app || fail "build: image build failed"
fi
e2e_compose up -d --wait --wait-timeout 300 || fail "start: the stack did not become healthy"

step "seed the upstream Weaver and Weaver"
# The seed is not in the image: bundle it into one file here and copy it into the running containers.
"$ROOT/apps/web/node_modules/.bin/esbuild" "$ROOT/apps/web/scripts/seed-e2e.ts" --bundle --platform=node \
  --format=esm --target=node22 --log-level=warning --external:pg-native \
  "--banner:js=import { createRequire as __seedCreateRequire } from 'node:module'; const require = __seedCreateRequire(import.meta.url);" \
  --outfile="$WORK/seed-e2e.mjs" || fail "seed: esbuild failed"

# Seeds compose service <service> with <spec file>; extra `-e NAME=value` args go to the exec. Echoes the SeedResult JSON.
seed() {
  local service="$1" spec="$2" container
  shift 2
  container="$(e2e_compose ps -q "$service")"
  [ -n "$container" ] || fail "seed: no running $service container"
  docker cp "$WORK/seed-e2e.mjs" "$container:/tmp/seed-e2e.mjs" >/dev/null || fail "seed: docker cp to $service"
  docker cp "$spec" "$container:/tmp/seed-spec.json" >/dev/null || fail "seed: docker cp spec to $service"
  e2e_compose exec -T -e WEAVER_E2E_SEED=1 "$@" "$service" node /tmp/seed-e2e.mjs /tmp/seed-spec.json | tail -n 1 | tr -d '\r' ||
    fail "seed: seeding $service failed"
}

# Echoes field <path> (dot-separated) of the JSON in file <file>, failing when it is missing.
json_field() {
  node -e '
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    if (typeof value !== "string" || value === "") process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2" || fail "seed: $1 has no $2"
}

seed upstream "$ROOT/scripts/e2e/upstream.json" >"$WORK/seed-upstream.json"
UPSTREAM_TOKEN="$(json_field "$WORK/seed-upstream.json" tokens.write)"
seed_env=(-e "UPSTREAM_PROTO_TOKEN=${UPSTREAM_TOKEN}")
[ -n "${DOCKERHUB_USERNAME:-}" ] && seed_env+=(-e "DOCKERHUB_USERNAME=${DOCKERHUB_USERNAME}")
[ -n "${DOCKERHUB_TOKEN:-}" ] && seed_env+=(-e "DOCKERHUB_TOKEN=${DOCKERHUB_TOKEN}")
seed app "$SPEC" "${seed_env[@]}" >"$WORK/seed-app.json"
TOKEN_WRITE="$(json_field "$WORK/seed-app.json" tokens.write)"
TOKEN_READ="$(json_field "$WORK/seed-app.json" tokens.read)"
TOKEN_GROUP="$(json_field "$WORK/seed-app.json" tokens.group)"
TOKEN_NONE="$(json_field "$WORK/seed-app.json" tokens.none)"
SESSION_COOKIE="$(json_field "$WORK/seed-app.json" sessionCookie)"
export UPSTREAM_TOKEN TOKEN_WRITE TOKEN_READ TOKEN_GROUP TOKEN_NONE SESSION_COOKIE

for f in "${FORMATS[@]}"; do
  [ -z "$f" ] && continue
  script="$ROOT/scripts/e2e/$f.sh"
  [ -f "$script" ] || fail "$f: $script does not exist"
  # A subshell in a condition would run with errexit off, so check its status separately.
  set +e
  # shellcheck disable=SC1090
  (
    set -e
    FORMAT="$f"
    . "$script"
  )
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { echo "E2E FAILED: $f (exit $rc)" >&2; exit 1; }
done

echo "E2E OK"
