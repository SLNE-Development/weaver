# npm end to end (sourced by run.sh): npm, pnpm, yarn classic, yarn berry and bun against Weaver's npm
# repositories - publish to hosted with every client, dist-tags, deprecate and unpublish, installs through the
# group, hosted and mirror repositories (cache off, on and with the upstream down), web and legacy login, denial,
# audit, search, cleanup and usage stats. Uses the run.sh exports and the lib.sh helpers; prints `E2E npm OK`.
#
# Every client runs with a fresh home, config and cache (`in_home`), so no user configuration or cache is read or
# written and no client-local cache can hide a broken registry. Client versions come from versions.env; pnpm and
# both yarns are installed from the npm registry into $WORK. bun runs natively when `bun --version` is $BUN, else in
# the oven/bun container (host network on Linux; elsewhere a forwarder inside the container keeps ${URL} valid).

NPM_URL="${URL}/npm"
VERDACCIO_URL="http://localhost:${E2E_VERDACCIO_PORT:-4873}"
FIXTURES="$ROOT/scripts/e2e/fixtures/npm"
IS_LINUX=0
[ "$(uname -s)" = "Linux" ] && IS_LINUX=1
CLIENTS=(npm pnpm yarn1 berry bun)

# The packages only the upstream has, per upstream mode.
if [ "$UPSTREAMS" = "local" ]; then
  UP_PKG=upstream-pkg UP_PKG_VERSION=1.0.0
  UP_SCOPED=@e2e/upstream-scoped UP_SCOPED_VERSION=1.0.0
else
  UP_PKG=is-number UP_PKG_VERSION=7.0.0
  UP_SCOPED=@types/semver UP_SCOPED_VERSION=7.5.8
fi

# Echoes the registry URL of npm repository <repo>.
reg() {
  echo "${NPM_URL}/$1/"
}

# Runs <cmd...> with a fresh home directory and every npm, pnpm, yarn and bun config and cache location inside
# it, after dropping inherited client settings from the environment.
in_home() {
  local home
  home="$(fresh_dir home)"
  mkdir -p "$home/appdata" "$home/localappdata" "$home/config" "$home/cache" "$home/data" "$home/state"
  : >"$home/global.npmrc"
  (
    for var in $(compgen -e); do
      case "${var,,}" in
        npm_config_* | yarn_* | pnpm_* | bun_* | corepack_*) unset "$var" ;;
      esac
    done
    export HOME="$home" USERPROFILE="$home" APPDATA="$home/appdata" LOCALAPPDATA="$home/localappdata"
    export XDG_CONFIG_HOME="$home/config" XDG_CACHE_HOME="$home/cache" XDG_DATA_HOME="$home/data" XDG_STATE_HOME="$home/state"
    export npm_config_userconfig="$home/.npmrc" npm_config_globalconfig="$home/global.npmrc" npm_config_cache="$home/npm-cache"
    export npm_config_update_notifier=false npm_config_fund=false
    # pnpm 11 refuses versions younger than a day by default; every package here was published seconds ago.
    export pnpm_config_store_dir="$home/pnpm-store" pnpm_config_minimum_release_age=0
    export YARN_CACHE_FOLDER="$home/yarn-cache" YARN_GLOBAL_FOLDER="$home/berry-global" YARN_ENABLE_TELEMETRY=0
    export BUN_INSTALL_CACHE_DIR="$home/bun-cache" COREPACK_HOME="$home/corepack"
    exec "$@"
  )
}

step "install the clients (pnpm ${PNPM}, yarn ${YARN_CLASSIC}, yarn ${YARN_BERRY}, bun ${BUN})"
TOOLS="$(fresh_dir tools)"
echo '{"private":true}' >"$TOOLS/package.json"
(cd "$TOOLS" && in_home npm install --no-audit --no-fund --loglevel=error \
  "pnpm@${PNPM}" "yarn@${YARN_CLASSIC}" "@yarnpkg/cli-dist@${YARN_BERRY}") >"$WORK/tools.log" 2>&1 ||
  fail "clients: npm install of pnpm and yarn failed: $(tail -n 20 "$WORK/tools.log")"
PNPM_JS="$TOOLS/node_modules/pnpm/bin/pnpm.cjs"
YARN1_JS="$TOOLS/node_modules/yarn/bin/yarn.js"
BERRY_JS="$TOOLS/node_modules/@yarnpkg/cli-dist/bin/yarn.js"
for js in "$PNPM_JS" "$YARN1_JS" "$BERRY_JS"; do [ -f "$js" ] || fail "clients: $js is missing"; done
BUN_NATIVE=0
if command -v bun >/dev/null 2>&1 && [ "$(bun --version 2>/dev/null)" = "$BUN" ]; then
  BUN_NATIVE=1
else
  docker image inspect "oven/bun:${BUN}" >/dev/null 2>&1 || docker pull -q "oven/bun:${BUN}" >/dev/null ||
    fail "clients: cannot pull oven/bun:${BUN}"
  # Inside the container, localhost:<port> must reach Weaver: the tarball URLs Weaver writes use ${URL}.
  cat >"$TOOLS/forward.mjs" <<'EOF'
import net from "node:net";
import fs from "node:fs";
const port = Number(process.argv[2]);
const target = process.argv[3];
net.createServer((client) => {
  const upstream = net.connect(port, target);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(port, "127.0.0.1", () => fs.writeFileSync("/tmp/forward-ready", ""));
EOF
fi
echo "pnpm $(in_home node "$PNPM_JS" --version), yarn $(in_home node "$YARN1_JS" --version), yarn $(in_home node "$BERRY_JS" --version), bun ${BUN} ($([ "$BUN_NATIVE" -eq 1 ] && echo native || echo "oven/bun container"))"

# Runs bun with <args...> in project directory <dir>, natively or in the oven/bun container.
bun_in() {
  local dir="$1"
  shift
  if [ "$BUN_NATIVE" -eq 1 ]; then
    (cd "$dir" && in_home bun "$@")
  elif [ "$IS_LINUX" -eq 1 ]; then
    docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
      -v "$dir:/work" -w /work "oven/bun:${BUN}" bun "$@"
  else
    docker run --rm -e HOME=/tmp -e BUN_INSTALL_CACHE_DIR=/tmp/bun-cache -v "$dir:/work" -w /work \
      -v "$TOOLS/forward.mjs:/forward.mjs:ro" "oven/bun:${BUN}" sh -c '
        bun /forward.mjs "$0" host.docker.internal &
        i=0; until [ -f /tmp/forward-ready ]; do i=$((i + 1)); [ "$i" -gt 100 ] && exit 97; sleep 0.1; done
        exec bun "$@"' "$E2E_PORT" "$@"
  fi
}

# Runs client <client> (npm|pnpm|yarn1|berry|bun) with <args...> in project directory <dir>.
client() {
  local name="$1" dir="$2"
  shift 2
  case "$name" in
    npm) (cd "$dir" && in_home npm "$@") ;;
    pnpm) (cd "$dir" && in_home node "$PNPM_JS" "$@") ;;
    yarn1) (cd "$dir" && in_home node "$YARN1_JS" "$@") ;;
    berry) (cd "$dir" && in_home node "$BERRY_JS" "$@") ;;
    bun) bun_in "$dir" "$@" ;;
    *) fail "client: unknown client $name" ;;
  esac
}

# Writes the registry config of <client> into <dir>: repository <repo> and, when given, <token>. Every client
# but yarn berry reads `.npmrc`; berry reads `.yarnrc.yml`. <auth> `basic` writes `_auth` instead of `_authToken`.
configure() {
  local name="$1" dir="$2" repo="$3" token="${4:-}" auth="${5:-token}"
  if [ "$name" = "berry" ]; then
    {
      echo "npmRegistryServer: \"$(reg "$repo")\""
      # Without npmAlwaysAuth berry sends the token only for scoped packages (any private registry needs it).
      if [ -n "$token" ]; then printf 'npmAuthToken: "%s"
npmAlwaysAuth: true
' "$token"; fi
      echo "nodeLinker: node-modules"
      echo "enableGlobalCache: false"
      echo "enableTelemetry: false"
      # Like pnpm, yarn berry quarantines young versions by default; these were published seconds ago.
      echo "npmMinimalAgeGate: 0"
      # yarn berry refuses plain http unless the host is listed (any plain-http registry needs this).
      echo "unsafeHttpWhitelist: [\"${HOST%%:*}\"]"
    } >"$dir/.yarnrc.yml"
    # An empty lockfile marks the project root, so yarn never walks up into another project.
    [ -f "$dir/yarn.lock" ] || : >"$dir/yarn.lock"
    return
  fi
  {
    echo "registry=$(reg "$repo")"
    if [ -n "$token" ] && [ "$auth" = "basic" ]; then
      echo "//${HOST}/npm/${repo}/:_auth=$(printf 'e2e:%s' "$token" | base64 | tr -d '\n')"
    elif [ -n "$token" ]; then
      echo "//${HOST}/npm/${repo}/:_authToken=${token}"
    fi
    # yarn classic sends the token for unscoped packages only with always-auth (any private registry needs it).
    if [ -n "$token" ] && [ "$name" = "yarn1" ]; then echo "//${HOST}/npm/${repo}/:always-auth=true"; fi
  } >"$dir/.npmrc"
}

# Copies fixture package <fixture> into a fresh directory configured for <client>, <repo> and <token>; with
# <name> and <version> it rewrites the package's name and version. Echoes the directory.
package_dir() {
  local fixture="$1" name="$2" repo="$3" token="$4" pkg_name="${5:-}" pkg_version="${6:-}" dir
  dir="$(fresh_dir "pkg-${fixture}")"
  cp -R "$FIXTURES/packages/$fixture/." "$dir/"
  if [ -n "$pkg_name" ]; then
    node -e '
      const fs = require("fs"), file = process.argv[1] + "/package.json", pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.name = process.argv[2]; pkg.version = process.argv[3];
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' "$dir" "$pkg_name" "$pkg_version"
  fi
  configure "$name" "$dir" "$repo" "$token"
  echo "$dir"
}

# Publishes the package in <dir> with <client>.
publish_with() {
  local name="$1" dir="$2"
  case "$name" in
    npm) client npm "$dir" publish ;;
    pnpm) client pnpm "$dir" publish --no-git-checks ;;
    yarn1) client yarn1 "$dir" publish --non-interactive --new-version "$(node -p "require('$dir/package.json').version")" ;;
    # A berry project is installed before it publishes (the workspace must be in the lockfile).
    berry) client berry "$dir" install --no-immutable && client berry "$dir" npm publish ;;
    bun) client bun "$dir" publish ;;
  esac
}

# Publishes fixture <fixture> to <repo> with <client> and <token> (optionally renamed to <name>@<version>).
publish_fixture() {
  local name="$1" fixture="$2" repo="$3" token="$4" dir
  dir="$(package_dir "$fixture" "$name" "$repo" "$token" "${5:-}" "${6:-}")"
  publish_with "$name" "$dir" >"$dir.publish.log" 2>&1 ||
    fail "publish ${5:-$fixture} with $name to $repo: $(tail -n 25 "$dir.publish.log")"
}

# Echoes the output of `npm <args...>` run in a fresh directory configured for <repo> and <token>.
npm_at() {
  local repo="$1" token="$2" dir
  shift 2
  dir="$(fresh_dir npm)"
  configure npm "$dir" "$repo" "$token"
  client npm "$dir" "$@"
}

# The lockfile <client> writes.
lockfile_of() {
  case "$1" in
    npm) echo package-lock.json ;;
    pnpm) echo pnpm-lock.yaml ;;
    yarn1 | berry) echo yarn.lock ;;
    bun) echo bun.lock ;;
  esac
}

# Writes the consumer project for <client> into a fresh directory, depending on <name@version...>, configured for
# <repo> and <token>. Echoes the directory.
consumer_dir() {
  local name="$1" repo="$2" token="$3" dir
  shift 3
  dir="$(fresh_dir "consumer-$name-$repo")"
  node -e '
    const fs = require("fs"), [file, out, ...deps] = process.argv.slice(1), pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.dependencies = Object.fromEntries(deps.map((d) => { const at = d.lastIndexOf("@"); return [d.slice(0, at), d.slice(at + 1)]; }));
    fs.writeFileSync(out + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
  ' "$FIXTURES/consumer/package.json" "$dir" "$@"
  configure "$name" "$dir" "$repo" "$token"
  echo "$dir"
}

# Installs the consumer in <dir> with <client>; <frozen> 1 installs strictly from the existing lockfile.
install_with() {
  local name="$1" dir="$2" frozen="${3:-0}"
  case "$name:$frozen" in
    npm:0) client npm "$dir" install --no-audit --no-fund ;;
    npm:1) client npm "$dir" ci --no-audit --no-fund ;;
    pnpm:0) client pnpm "$dir" install --no-frozen-lockfile ;;
    pnpm:1) client pnpm "$dir" install --frozen-lockfile ;;
    yarn1:0) client yarn1 "$dir" install --non-interactive ;;
    yarn1:1) client yarn1 "$dir" install --non-interactive --frozen-lockfile ;;
    berry:0) client berry "$dir" install --no-immutable ;;
    berry:1) client berry "$dir" install --immutable ;;
    bun:0) client bun "$dir" install ;;
    bun:1) client bun "$dir" install --frozen-lockfile ;;
  esac
}

# Asserts that every URL in <client>'s lockfile in <dir> lies under repository <repo> and none points at the
# upstream. npm, yarn classic and bun always record tarball URLs, so their lockfiles must contain at least one.
check_lockfile() {
  local name="$1" dir="$2" repo="$3" file url count=0
  file="$dir/$(lockfile_of "$name")"
  [ -s "$file" ] || fail "lockfile: $name wrote no $(lockfile_of "$name")"
  if grep -nE "${E2E_VERDACCIO_PORT:-4873}|verdaccio|registry\.npmjs\.org|registry\.yarnpkg\.com" "$file" >"$WORK/lock.hits"; then
    fail "lockfile: $name's $(lockfile_of "$name") points at the upstream: $(head -n 5 "$WORK/lock.hits")"
  fi
  while IFS= read -r url; do
    count=$((count + 1))
    case "$url" in
      "${NPM_URL}/${repo}/"*) ;;
      *) fail "lockfile: $name's $(lockfile_of "$name") resolves $url outside ${NPM_URL}/${repo}/" ;;
    esac
  done < <(grep -oE "https?://[^\"' ,#)]+" "$file" | sort -u)
  if [ "$count" -eq 0 ] && { [ "$name" = "npm" ] || [ "$name" = "yarn1" ] || [ "$name" = "bun" ]; }; then
    fail "lockfile: $name's $(lockfile_of "$name") records no tarball URL"
  fi
}

# Installs a consumer of <name@version...> from <repo> with <client> and <token>, checks the lockfile and that
# the first dependency loads, then installs again from that lockfile in a fresh directory with fresh caches.
# Echoes the first project directory.
install_consumer() {
  local name="$1" repo="$2" token="$3" dir again first
  shift 3
  first="${1%@*}"
  dir="$(consumer_dir "$name" "$repo" "$token" "$@")"
  install_with "$name" "$dir" >"$dir/install.log" 2>&1 ||
    fail "install via $repo with $name: $(tail -n 25 "$dir/install.log")"
  check_lockfile "$name" "$dir" "$repo"
  (cd "$dir" && node -e 'require(process.argv[1])' "$first") >/dev/null 2>&1 ||
    fail "install via $repo with $name: require('$first') failed"
  again="$(fresh_dir "reinstall-$name-$repo")"
  cp "$dir/package.json" "$dir/$(lockfile_of "$name")" "$again/"
  configure "$name" "$again" "$repo" "$token"
  install_with "$name" "$again" 1 >"$again/install.log" 2>&1 ||
    fail "install via $repo with $name from its lockfile: $(tail -n 25 "$again/install.log")"
  (cd "$again" && node -e 'require(process.argv[1])' "$first") >/dev/null 2>&1 ||
    fail "install via $repo with $name from its lockfile: require('$first') failed"
  echo "$dir"
}

# Enqueues maintenance job <json> with @weaver/jobs inside the worker container and waits until it completed.
run_job() {
  e2e_compose exec -T -w /app/apps/worker worker node --input-type=module -e '
import { createQueue, producerConnection } from "@weaver/jobs";
const data = JSON.parse(process.argv[1]);
const queue = createQueue(producerConnection(process.env.VALKEY_URL));
try {
  const job = await queue.add(data.kind, data);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await job.getState();
    if (state === "completed") break;
    if (state === "failed") { const done = await queue.getJob(job.id); throw new Error(`${data.kind} failed: ${done?.failedReason}`); }
    if (Date.now() > deadline) throw new Error(`${data.kind} still ${state} after 60s`);
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await queue.close();
}
' "$1" || fail "job: $1 did not complete"
}

# Echoes the JSON value at <path> (dot-separated, `.` for the whole document) of the JSON on stdin.
json_at() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1] === "." ? [] : process.argv[1].split(".")) v = v?.[k];
      process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });
  ' "$1"
}

# ---------------------------------------------------------------------------------------------------------------

if [ "$UPSTREAMS" = "local" ]; then
  step "preload the upstream (Verdaccio): ${UP_PKG}, ${UP_SCOPED}, shared-pkg@1.0.0"
  expect_status 201 PUT "${VERDACCIO_URL}/-/user/org.couchdb.user:e2e" -H 'content-type: application/json' \
    --data '{"name":"e2e","password":"e2e-verdaccio-pass"}'
  VERDACCIO_TOKEN="$(json_at token <"$WORK/last.body")"
  [ -n "$VERDACCIO_TOKEN" ] || fail "preload: verdaccio returned no token"
  for fixture in upstream-pkg upstream-scoped shared-1.0.0; do
    dir="$(fresh_dir "upstream-$fixture")"
    cp -R "$FIXTURES/packages/$fixture/." "$dir/"
    printf 'registry=%s/\n//localhost:%s/:_authToken=%s\n' "$VERDACCIO_URL" "${E2E_VERDACCIO_PORT:-4873}" "$VERDACCIO_TOKEN" >"$dir/.npmrc"
    client npm "$dir" publish >"$dir.publish.log" 2>&1 || fail "preload $fixture: $(tail -n 20 "$dir.publish.log")"
  done
fi

step "publish to npm-hosted with npm, pnpm, yarn classic, yarn berry and bun"
for fixture in hello-1.0.0 hello-1.1.0 shared-2.0.0 gone; do
  publish_fixture npm "$fixture" npm-hosted "$TOKEN_WRITE"
done
for c in "${CLIENTS[@]}"; do
  publish_fixture "$c" "pub-$c" npm-hosted "$TOKEN_WRITE"
done
for c in "${CLIENTS[@]}"; do
  got="$(npm_at npm-hosted "$TOKEN_READ" view "@e2e/pub-$c" version 2>&1)" || fail "publish: npm view @e2e/pub-$c: $got"
  [ "$got" = "1.0.0" ] || fail "publish: @e2e/pub-$c has version '$got', expected 1.0.0"
done
dir="$(package_dir hello-1.0.0 npm npm-hosted "$TOKEN_WRITE")"
expect_fail 'E403|E409|cannot publish over' client npm "$dir" publish

step "one npm publish authenticates with _auth (Basic) instead of _authToken"
dir="$(package_dir hello-1.0.0 npm npm-hosted "$TOKEN_WRITE" @e2e/basic-auth 1.0.0)"
configure npm "$dir" npm-hosted "$TOKEN_WRITE" basic
client npm "$dir" publish >"$dir.publish.log" 2>&1 || fail "publish with _auth: $(tail -n 20 "$dir.publish.log")"
got="$(npm_at npm-hosted "$TOKEN_READ" view @e2e/basic-auth version 2>&1)" || fail "publish with _auth: npm view: $got"
[ "$got" = "1.0.0" ] || fail "publish with _auth: version '$got'"

step "dist-tags, deprecate and unpublish"
w="$(fresh_dir npm-write)"
configure npm "$w" npm-hosted "$TOKEN_WRITE"
client npm "$w" dist-tag add @e2e/hello@1.0.0 beta >/dev/null 2>&1 || fail "dist-tag add failed"
tags="$(client npm "$w" dist-tag ls @e2e/hello 2>&1)" || fail "dist-tag ls: $tags"
printf '%s\n' "$tags" | grep -qx 'beta: 1.0.0' || fail "dist-tag ls lacks 'beta: 1.0.0': $tags"
printf '%s\n' "$tags" | grep -qx 'latest: 1.1.0' || fail "dist-tag ls lacks 'latest: 1.1.0': $tags"
client npm "$w" dist-tag rm @e2e/hello beta >/dev/null 2>&1 || fail "dist-tag rm failed"
tags="$(client npm "$w" dist-tag ls @e2e/hello 2>&1)" || fail "dist-tag ls: $tags"
printf '%s\n' "$tags" | grep -q '^beta:' && fail "dist-tag rm left beta: $tags"
client npm "$w" deprecate @e2e/hello@1.0.0 "use 1.1.0" >/dev/null 2>&1 || fail "deprecate failed"
got="$(client npm "$w" view @e2e/hello@1.0.0 deprecated 2>&1)" || fail "view deprecated: $got"
[ "$got" = "use 1.1.0" ] || fail "deprecated is '$got', expected 'use 1.1.0'"
client npm "$w" unpublish @e2e/gone@1.0.0 --force >"$WORK/unpublish.log" 2>&1 || fail "unpublish @e2e/gone: $(cat "$WORK/unpublish.log")"
expect_fail 'E404' client npm "$w" view @e2e/gone

step "install through npm-group with every client (group-only token)"
for c in "${CLIENTS[@]}"; do
  install_consumer "$c" npm-group "$TOKEN_GROUP" "@e2e/hello@1.1.0" "${UP_SCOPED}@${UP_SCOPED_VERSION}" "${UP_PKG}@${UP_PKG_VERSION}" >/dev/null
done

step "install from npm-hosted and npm-mirror with every client, then again from the lockfile"
for c in "${CLIENTS[@]}"; do
  hosted="$(install_consumer "$c" npm-hosted "$TOKEN_READ" "@e2e/hello@1.1.0")"
  mirror="$(install_consumer "$c" npm-mirror "$TOKEN_READ" "${UP_PKG}@${UP_PKG_VERSION}" "${UP_SCOPED}@${UP_SCOPED_VERSION}")"
  case "$c" in
    npm) HOSTED_NPM_PROJECT="$hosted" MIRROR_NPM_PROJECT="$mirror" ;;
    pnpm) HOSTED_PNPM_PROJECT="$hosted" MIRROR_PNPM_PROJECT="$mirror" ;;
  esac
done

if [ "$UPSTREAMS" = "local" ]; then
  step "the group merges shared-pkg (upstream 1.0.0, hosted 2.0.0)"
  got="$(npm_at npm-group "$TOKEN_GROUP" view shared-pkg versions --json 2>&1)" || fail "merged packument: $got"
  [ "$(printf '%s' "$got" | json_at .)" = '["1.0.0","2.0.0"]' ] || fail "merged packument versions: $got"
  got="$(npm_at npm-group "$TOKEN_GROUP" view shared-pkg dist-tags.latest 2>&1)" || fail "merged packument: $got"
  [ "$got" = "2.0.0" ] || fail "merged packument: dist-tags.latest is '$got', expected 2.0.0 (hosted member wins)"
fi

step "npm audit and pnpm audit against npm-hosted and npm-mirror"
out="$(client npm "$HOSTED_NPM_PROJECT" audit 2>&1)" || fail "npm audit via npm-hosted: $out"
printf '%s' "$out" | grep -q 'found 0 vulnerabilities' || fail "npm audit via npm-hosted: $out"
out="$(client pnpm "$HOSTED_PNPM_PROJECT" audit 2>&1)" || fail "pnpm audit via npm-hosted: $out"
printf '%s' "$out" | grep -qi 'no known vulnerabilities' || fail "pnpm audit via npm-hosted: $out"
# The mirror forwards the audit upstream: whatever the upstream answers, it is not a Weaver error.
out="$(client npm "$MIRROR_NPM_PROJECT" audit 2>&1)" && rc=0 || rc=$?
if printf '%s' "$out" | grep -qE '502|upstream_unavailable|Bad Gateway'; then fail "npm audit via npm-mirror: Weaver error: $out"; fi
echo "npm audit via npm-mirror (exit $rc): $(printf '%s' "$out" | tail -n 1)"
out="$(client pnpm "$MIRROR_PNPM_PROJECT" audit 2>&1)" && rc=0 || rc=$?
if printf '%s' "$out" | grep -qE '502|upstream_unavailable|Bad Gateway'; then fail "pnpm audit via npm-mirror: Weaver error: $out"; fi
echo "pnpm audit via npm-mirror (exit $rc): $(printf '%s' "$out" | tail -n 1)"

step "mirror with cache off, cache on and the upstream down"
npm_install_one() {
  local repo="$1" dir
  shift
  dir="$(consumer_dir npm "$repo" "$TOKEN_READ" "${UP_PKG}@${UP_PKG_VERSION}")"
  client npm "$dir" install --no-audit --no-fund "$@"
}
npm_install_one npm-mirror >"$WORK/mirror.log" 2>&1 || fail "install via npm-mirror: $(tail -n 20 "$WORK/mirror.log")"
[ "$(asset_count npm-mirror)" = "0" ] || fail "npm-mirror (cache off) stored $(asset_count npm-mirror) assets"
if [ "$UPSTREAMS" = "real" ]; then
  step "rules: a package outside npm-mirror's allow list is 404 and never reaches registry.npmjs.org"
  bypass="$(cache_events npm-mirror bypass)"
  [ "$bypass" -ge 1 ] || fail "rules: the allowed ${UP_PKG} recorded no bypass on npm-mirror"
  expect_status 404 GET "$(reg npm-mirror)left-pad" -H "authorization: Bearer ${TOKEN_READ}"
  expect_status 404 GET "$(reg npm-mirror)left-pad/-/left-pad-1.3.0.tgz" -H "authorization: Bearer ${TOKEN_READ}"
  [ "$(cache_events npm-mirror bypass)" = "$bypass" ] || fail "rules: left-pad reached the upstream of npm-mirror"
fi
for i in 1 2; do
  npm_install_one npm-cached >"$WORK/cached.log" 2>&1 || fail "install $i via npm-cached: $(tail -n 20 "$WORK/cached.log")"
done
[ "$(asset_count npm-cached cache)" -ge 1 ] || fail "npm-cached stored no cache assets"
[ "$(asset_stores npm-cached)" = "s3" ] || fail "npm-cached assets are in '$(asset_stores npm-cached)', expected s3"
[ "$(cache_events npm-cached hit)" -ge 1 ] || fail "npm-cached recorded no cache hit"
upstream_down npm
npm_install_one npm-cached >"$WORK/cached.log" 2>&1 || fail "install via npm-cached with the upstream down: $(tail -n 20 "$WORK/cached.log")"
if [ "$UPSTREAMS" = "local" ]; then
  # No retries: npm would otherwise back off for a minute before giving up on the 502.
  expect_fail 'E502' npm_install_one npm-mirror --fetch-retries=0
else
  expect_fail 'E404' npm_install_one npm-mirror --fetch-retries=0
fi
upstream_up npm

step "npm web login (--auth-type=web) approved in a browser"
login="$(fresh_dir login)"
pkg="$(package_dir pub-npm npm npm-hosted "" @e2e/pub-login 1.0.0)"
rm -f "$pkg/.npmrc"
(cd "$login" && in_home npm login --auth-type=web "--registry=$(reg npm-hosted)" "--userconfig=$login/.npmrc") \
  </dev/null >"$login/login.log" 2>&1 &
login_pid=$!
login_url=""
for _ in $(seq 1 40); do
  # npm first names the registry ("Log in on ${URL}/npm/..."), then prints the browser URL.
  login_url="$(grep -oE "${URL}/[^[:space:]]+" "$login/login.log" | grep -v "^${URL}/npm/" | head -n 1 || true)"
  [ -n "$login_url" ] && break
  kill -0 "$login_pid" 2>/dev/null || break
  sleep 0.5
done
[ -n "$login_url" ] || { kill "$login_pid" 2>/dev/null; fail "web login: npm printed no login URL within 20s: $(cat "$login/login.log")"; }
node "$ROOT/scripts/e2e/npm-web-login.mjs" "$login_url" "$SESSION_COOKIE" "$URL" ||
  { kill "$login_pid" 2>/dev/null; fail "web login: the browser could not approve $login_url"; }
for _ in $(seq 1 60); do
  kill -0 "$login_pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$login_pid" 2>/dev/null; then
  kill "$login_pid" 2>/dev/null
  fail "web login: npm login still running 30s after the approval: $(cat "$login/login.log")"
fi
wait "$login_pid" || fail "web login: npm login failed: $(cat "$login/login.log")"
who="$(cd "$login" && in_home npm whoami "--registry=$(reg npm-hosted)" "--userconfig=$login/.npmrc" 2>&1)" ||
  fail "web login: npm whoami: $who"
[ -n "$who" ] || fail "web login: npm whoami printed no name"
(cd "$pkg" && in_home npm publish "--registry=$(reg npm-hosted)" "--userconfig=$login/.npmrc") >"$pkg.publish.log" 2>&1 ||
  fail "web login: publish with the login token: $(tail -n 20 "$pkg.publish.log")"

step "legacy couchdb login (yarn berry's wire format)"
body="$(printf '{"_id":"org.couchdb.user:e2e","name":"e2e","password":"%s","type":"user","roles":[],"date":"%s"}' \
  "$TOKEN_WRITE" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")"
expect_status 201 PUT "$(reg npm-hosted)-/user/org.couchdb.user:e2e" -H 'content-type: application/json' --data "$body"
[ "$(json_at token <"$WORK/last.body")" = "$TOKEN_WRITE" ] || fail "legacy login: token is not the password: $(cat "$WORK/last.body")"
expect_status 401 PUT "$(reg npm-hosted)-/user/org.couchdb.user:e2e" -H 'content-type: application/json' \
  --data '{"_id":"org.couchdb.user:e2e","name":"e2e","password":"nope","type":"user","roles":[],"date":"2026-01-01T00:00:00.000Z"}'

step "denial: anonymous, no permission, read-only publish, publish to a group"
expect_fail 'E401' npm_at npm-hosted "" view @e2e/hello
expect_fail 'E403' npm_at npm-hosted "$TOKEN_NONE" view @e2e/hello
dir="$(package_dir hello-1.0.0 npm npm-hosted "$TOKEN_READ" @e2e/denied 1.0.0)"
expect_fail 'E403' client npm "$dir" publish
dir="$(package_dir hello-1.0.0 npm npm-group "$TOKEN_WRITE" @e2e/denied 1.0.0)"
expect_fail 'E405' client npm "$dir" publish
publish_fixture npm hello-1.0.0 npm-public "$TOKEN_WRITE" @e2e/public-pkg 1.0.0
dir="$(consumer_dir npm npm-public "" "@e2e/public-pkg@1.0.0")"
client npm "$dir" install --no-audit --no-fund >"$dir/install.log" 2>&1 ||
  fail "anonymous install from npm-public: $(tail -n 20 "$dir/install.log")"

step "npm, pnpm, yarn berry and bun publish an unscoped package; republishing it fails"
for c in npm pnpm berry bun; do
  publish_fixture "$c" "pub-$c" npm-hosted "$TOKEN_WRITE" "e2e-unscoped-$c" 1.0.0
  dir="$(package_dir "pub-$c" "$c" npm-hosted "$TOKEN_WRITE" "e2e-unscoped-$c" 1.0.0)"
  expect_fail '409|403|[Cc]onflict|cannot publish|already (exists|published)|previously published' publish_with "$c" "$dir"
done

step "unpublish one version, npm search, npm ping and npm whoami against npm-hosted"
publish_fixture npm hello-1.0.0 npm-hosted "$TOKEN_WRITE" @e2e/unpub 1.0.0
publish_fixture npm hello-1.0.0 npm-hosted "$TOKEN_WRITE" @e2e/unpub 1.1.0
client npm "$w" unpublish @e2e/unpub@1.0.0 >"$WORK/unpublish.log" 2>&1 || fail "unpublish @e2e/unpub@1.0.0: $(cat "$WORK/unpublish.log")"
got="$(client npm "$w" view @e2e/unpub versions --json 2>&1)" || fail "view @e2e/unpub: $got"
case "$(printf '%s' "$got" | json_at .)" in
  '["1.1.0"]' | '"1.1.0"') ;;
  *) fail "@e2e/unpub versions after unpublishing 1.0.0: $got" ;;
esac
got="$(client npm "$w" search @e2e/hello 2>&1)" || fail "npm search: $got"
printf '%s' "$got" | grep -q '@e2e/hello' || fail "npm search did not find @e2e/hello: $got"
client npm "$w" ping >"$WORK/ping.log" 2>&1 || fail "npm ping: $(cat "$WORK/ping.log")"
got="$(client npm "$w" whoami 2>&1)" || fail "npm whoami: $got"
[ "$got" = "E2E Admin" ] || fail "npm whoami printed '$got', expected 'E2E Admin'"

step "cleanup keep_last_versions 1 keeps the tagged and the newest version"
for v in 1.0.0 1.1.0 1.2.0; do
  publish_fixture npm hello-1.0.0 npm-hosted "$TOKEN_WRITE" @e2e/cleanup "$v"
done
client npm "$w" dist-tag add @e2e/cleanup@1.0.0 latest >/dev/null 2>&1 || fail "cleanup: dist-tag latest on 1.0.0 failed"
sql "INSERT INTO cleanup_policy (repository_id, kind, value, group_prefix) SELECT id, 'keep_last_versions', 1, '@e2e/cleanup' FROM repository WHERE name = 'npm-hosted'" >/dev/null
run_job '{"kind":"cleanup:repo","repository":"npm-hosted"}'
got="$(client npm "$w" view @e2e/cleanup versions --json 2>&1)" || fail "cleanup: npm view: $got"
[ "$(printf '%s' "$got" | json_at .)" = '["1.0.0","1.2.0"]' ] || fail "cleanup: versions are $got, expected the tagged 1.0.0 and the newest 1.2.0"
dir="$(consumer_dir npm npm-hosted "$TOKEN_READ" "@e2e/cleanup@latest")"
client npm "$dir" install --no-audit --no-fund >"$dir/install.log" 2>&1 || fail "cleanup: npm install: $(tail -n 20 "$dir/install.log")"
dir="$(consumer_dir pnpm npm-hosted "$TOKEN_READ")"
client pnpm "$dir" add @e2e/cleanup >"$dir/install.log" 2>&1 || fail "cleanup: pnpm add: $(tail -n 20 "$dir/install.log")"

step "search finds @e2e/hello for the read token, not for a token without permissions"
search() {
  curl -sS -G -H "authorization: Bearer $1" --data-urlencode 'input={"json":{"q":"@e2e/hello","format":"npm"}}' \
    "${URL}/api/trpc/search.query"
}
got="$(search "$TOKEN_READ")" || fail "search: curl failed"
printf '%s' "$got" | grep -q '"hello"\|@e2e/hello' || fail "search with the read token did not find @e2e/hello: $(printf '%s' "$got" | head -c 600)"
got="$(search "$TOKEN_NONE")" || fail "search: curl failed"
printf '%s' "$got" | grep -q '"hits"' || fail "search with the empty token: no hits list: $(printf '%s' "$got" | head -c 600)"
if printf '%s' "$got" | grep -q '"hello"\|@e2e/hello'; then fail "search with the empty token found @e2e/hello: $(printf '%s' "$got" | head -c 600)"; fi

step "usage stats after pulls through npm-cached and a stats:rollup"
# Echoes the visible text of the HTML page in <file> (scripts and tags removed, whitespace collapsed).
page_text() {
  node -e '
    const html = require("fs").readFileSync(process.argv[1], "utf8").replace(/<script[\s\S]*?<\/script>/g, " ");
    process.stdout.write(html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " "));
  ' "$1"
}
run_job '{"kind":"stats:rollup"}'
expect_status 200 GET "${URL}/browse/npm-cached/stats" -H "cookie: better-auth.session_token=${SESSION_COOKIE}"
page_text "$WORK/last.body" >"$WORK/stats.txt"
expect_contains 'Cache [0-9.]+ ?(B|KiB|MiB)' "$WORK/stats.txt"
if grep -qE 'Cache 0 B' "$WORK/stats.txt"; then fail "stats: npm-cached shows no cache size: $(cat "$WORK/stats.txt")"; fi
expect_contains 'Hit rate [1-9][0-9]*(\.[0-9]+)?%' "$WORK/stats.txt"
expect_contains "Top packages Package Downloads ${UP_PKG} [1-9]" "$WORK/stats.txt"
key_id="$(sql "SELECT id FROM apikey WHERE name = 'e2e-read' ORDER BY created_at DESC LIMIT 1")"
[ -n "$key_id" ] || fail "stats: no e2e-read key"
expect_status 200 GET "${URL}/keys/${key_id}/activity" -H "cookie: better-auth.session_token=${SESSION_COOKIE}"
page_text "$WORK/last.body" >"$WORK/activity.txt"
expect_contains "download npm-cached ${UP_PKG} ${UP_PKG}/-/${UP_PKG}-${UP_PKG_VERSION}\.tgz" "$WORK/activity.txt"

echo "E2E npm OK"
