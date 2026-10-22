# Proto end to end (sourced by run.sh): the Gradle plugin publishes to the upstream Weaver and to
# Weaver, buf rejects a broken bundle, and the `weaver` CLI and Gradle `fetchProtos` read through
# hosted, mirror (cache off and on, upstream down) and group repositories, with permission denials.
# Uses the run.sh exports and the lib.sh helpers; prints `E2E proto OK`.

FIXTURES="$ROOT/scripts/e2e/fixtures/proto"
CLI="$ROOT/packages/cli/dist/index.js"

# One Gradle user home for this run (the wrapper distribution and plugin build dependencies are
# downloaded once); the plugin's archive cache inside it is wiped before every Gradle invocation,
# so no client-side copy of an archive can hide what the server answers.
GRADLE_HOME_DIR="$(fresh_dir gradle)"
# Optional: E2E_JAVA_INSTALLATIONS (comma-separated JDK homes) lets Gradle use installed JDKs for the
# plugin's toolchain instead of provisioning one into the fresh user home.
if [ -n "${E2E_JAVA_INSTALLATIONS:-}" ]; then
  echo "org.gradle.java.installations.paths=${E2E_JAVA_INSTALLATIONS}" >"$GRADLE_HOME_DIR/gradle.properties"
fi

# Runs the Gradle wrapper in fixture <dir> against <url> with <token>; further args go to Gradle.
gradle_run() {
  local dir="$1" url="$2" token="$3"
  shift 3
  rm -rf "$GRADLE_HOME_DIR/caches/weaver"
  (
    cd "$dir" &&
      GRADLE_USER_HOME="$GRADLE_HOME_DIR" WEAVER_URL="$url" WEAVER_TOKEN="$token" \
        "$ROOT/gradle-plugin/gradlew" --no-daemon --console=plain --project-cache-dir "$GRADLE_HOME_DIR/project-cache/$(basename "$dir")" "$@"
  )
}

# Copies node-sample into a fresh directory (with its own node_modules, so the CLI's archive cache
# lives there) whose weaver.json reads <repositories> and <dependencies> (comma-separated); echoes it.
cli_project() {
  local dir
  dir="$(fresh_dir cli)"
  cp -r "$FIXTURES/node-sample/." "$dir/" || fail "cli_project: copy node-sample"
  mkdir -p "$dir/node_modules"
  node -e '
    const [file, repositories, dependencies] = process.argv.slice(1);
    const config = JSON.parse(require("fs").readFileSync(file, "utf8"));
    config.repositories = repositories.split(",");
    config.dependencies = dependencies.split(",");
    require("fs").writeFileSync(file, JSON.stringify(config, null, 2));
  ' "$dir/weaver.json" "$1" "$2" || fail "cli_project: write weaver.json"
  echo "$dir"
}

# Runs `weaver fetch` in <dir> against Weaver with <token> (empty: anonymous).
weaver_fetch() {
  (cd "$1" && WEAVER_URL="$URL" WEAVER_TOKEN="$2" node "$CLI" fetch)
}

# Asserts that a fetched output tree under <dir> has a file whose path ends in <suffix>; echoes it.
fetched_file() {
  local found
  found="$(find "$1" -type f -path "*$2" | head -n 1)"
  [ -n "$found" ] || fail "fetched_file: no $2 under $1: $(find "$1" -type f | head -n 20)"
  echo "$found"
}

# Echoes field <path> (dot-separated, numeric segments index arrays) of the JSON file <file>.
json_get() {
  node -e '
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$1" "$2" || fail "json_get: $1 has no $2: $(head -c 600 "$1")"
}

# Asserts <actual> >= <minimum> for a count named <what>.
expect_at_least() {
  [ "$2" -ge "$3" ] 2>/dev/null || fail "$1: expected at least $3, got '$2'"
}

step "1. publish upstream-sample (dev.upstream:base:1.0.0) to the upstream Weaver with the Gradle plugin"
gradle_run "$FIXTURES/upstream-sample" "$UPSTREAM_URL" "$UPSTREAM_TOKEN" publishProtos ||
  fail "1: publishProtos to the upstream Weaver failed"

step "2. publish gradle-sample (dev.smoke:sample:1.0.0) to proto-hosted; a republish is denied"
gradle_run "$FIXTURES/gradle-sample" "$URL" "$TOKEN_WRITE" publishProtos || fail "2: publishProtos to proto-hosted failed"
expect_fail 'already exists|409' gradle_run "$FIXTURES/gradle-sample" "$URL" "$TOKEN_WRITE" publishProtos
gradle_run "$FIXTURES/gradle-sample" "$URL" "$TOKEN_WRITE" publishProtos -PpublishRepository=proto-public ||
  fail "2: publishProtos to proto-public failed"

step "3. buf rejects a bundle with a missing import"
BROKEN="$(fresh_dir broken)"
mkdir -p "$BROKEN/src/broken/v1"
printf 'syntax = "proto3";\npackage broken.v1;\nimport "missing/v1/nope.proto";\nmessage Broken { missing.v1.Nope nope = 1; }\n' \
  >"$BROKEN/src/broken/v1/broken.proto"
(cd "$BROKEN/src" && tar -czf ../broken.tar.gz broken) || fail "3: tar failed"
printf '{"group":"dev.smoke","name":"broken","version":"1.0.0","dependencies":[]}' >"$BROKEN/manifest.json"
expect_status 422 PUT "${URL}/api/v1/repos/proto-hosted/artifacts/dev.smoke/broken/1.0.0" \
  -H "Authorization: Bearer ${TOKEN_WRITE}" \
  -F "manifest=<$BROKEN/manifest.json" \
  -F "archive=@$BROKEN/broken.tar.gz;type=application/gzip"
expect_contains '"validation_failed"' "$WORK/last.body"
expect_contains 'missing/v1/nope.proto' "$WORK/last.body"

step "10. Gradle fetchProtos from proto-hosted writes smoke/v1/hello.proto"
CONSUMER="$FIXTURES/gradle-consumer"
rm -rf "$CONSUMER/build/weaver"
gradle_run "$CONSUMER" "$URL" "$TOKEN_READ" fetchProtos -PweaverRepositories=proto-hosted \
  -PweaverDependencies=dev.smoke:sample:1.0.0 || fail "10: fetchProtos from proto-hosted failed"
expect_contains 'message Hello' "$(fetched_file "$CONSUMER/build/weaver/protos" smoke/v1/hello.proto)"

step "4. group read: the CLI with a group-only token gets both the hosted and the mirrored bundle"
DIR="$(cli_project proto-group dev.smoke:sample:1.0.0,dev.upstream:base:1.0.0)"
weaver_fetch "$DIR" "$TOKEN_GROUP" || fail "4: weaver fetch through proto-group failed"
expect_contains 'message Hello' "$(fetched_file "$DIR/protos" smoke/v1/hello.proto)"
fetched_file "$DIR/protos" base/v1/base.proto >/dev/null

step "5. mirror with cache off: the CLI fetches through proto-mirror and nothing is stored"
DIR="$(cli_project proto-mirror dev.upstream:base:1.0.0)"
weaver_fetch "$DIR" "$TOKEN_READ" || fail "5: weaver fetch through proto-mirror failed"
expect_contains 'message Base' "$(fetched_file "$DIR/protos" base/v1/base.proto)"
count="$(asset_count proto-mirror)"
[ "$count" = "0" ] || fail "5: proto-mirror has $count asset rows with caching off"

step "6. mirror with cache on: two fetches through proto-cached store the bundle in s3 and hit the cache"
for i in 1 2; do
  DIR="$(cli_project proto-cached dev.upstream:base:1.0.0)"
  weaver_fetch "$DIR" "$TOKEN_READ" || fail "6: weaver fetch $i through proto-cached failed"
  fetched_file "$DIR/protos" base/v1/base.proto >/dev/null
done
expect_at_least "6: proto-cached cache assets" "$(asset_count proto-cached cache)" 1
stores="$(asset_stores proto-cached)"
[ "$stores" = "s3" ] || fail "6: proto-cached assets are in '$stores', expected s3"
expect_at_least "6: proto-cached cache hits" "$(cache_events proto-cached hit)" 1

step "7. upstream down: proto-cached still serves, proto-mirror fails with 502"
upstream_down proto
DIR="$(cli_project proto-cached dev.upstream:base:1.0.0)"
weaver_fetch "$DIR" "$TOKEN_READ" || fail "7: weaver fetch through proto-cached with the upstream down failed"
fetched_file "$DIR/protos" base/v1/base.proto >/dev/null
DIR="$(cli_project proto-mirror dev.upstream:base:1.0.0)"
# The CLI prints the server message (`error: <message>`, see docs/cli.md); the code is checked on the wire.
expect_fail 'No upstream of proto-mirror could serve' weaver_fetch "$DIR" "$TOKEN_READ"
expect_status 502 POST "${URL}/api/v1/resolve" -H "Authorization: Bearer ${TOKEN_READ}" -H 'content-type: application/json'   --data '{"repositories":["proto-mirror"],"dependencies":["dev.upstream:base:1.0.0"]}'
expect_contains '"upstream_unavailable"' "$WORK/last.body"
upstream_up proto

step "8. denials: no permission, anonymous, read-only publish and publish to a group"
# The proto API shows a private repository the caller can't read exactly like a missing one
# (404 not_found, never 401 or 403; docs/api.md), so neither leaks that it exists.
DIR="$(cli_project proto-hosted dev.smoke:sample:1.0.0)"
expect_fail 'dev.smoke:sample:1.0.0 was not found' weaver_fetch "$DIR" "$TOKEN_NONE"
expect_status 404 GET "${URL}/api/v1/repos/proto-hosted/artifacts/dev.smoke/sample/1.0.0/archive"   -H "Authorization: Bearer ${TOKEN_NONE}"
expect_contains '"not_found"' "$WORK/last.body"
expect_status 404 GET "${URL}/api/v1/repos/proto-hosted/artifacts/dev.smoke/sample"
expect_contains '"not_found"' "$WORK/last.body"
expect_status 401 GET "${URL}/api/v1/repos/proto-public/artifacts/dev.smoke/sample" -H "Authorization: Bearer pl_not-a-key"
expect_status 200 GET "${URL}/api/v1/repos/proto-public/artifacts/dev.smoke/sample"
expect_contains '"1.0.0"' "$WORK/last.body"
DIR="$(cli_project proto-public dev.smoke:sample:1.0.0)"
weaver_fetch "$DIR" "" || fail "8: anonymous weaver fetch from proto-public failed"
fetched_file "$DIR/protos" smoke/v1/hello.proto >/dev/null
expect_fail 'forbidden|403' gradle_run "$FIXTURES/gradle-sample" "$URL" "$TOKEN_READ" publishProtos
SAMPLE_ARCHIVE="$FIXTURES/gradle-sample/build/weaver/publish/protos.tar.gz"
[ -f "$SAMPLE_ARCHIVE" ] || fail "8: packProtos left no $SAMPLE_ARCHIVE"
printf '{"group":"dev.smoke","name":"sample","version":"2.0.0","dependencies":[]}' >"$WORK/group-manifest.json"
expect_status 405 PUT "${URL}/api/v1/repos/proto-group/artifacts/dev.smoke/sample/2.0.0" \
  -H "Authorization: Bearer ${TOKEN_WRITE}" \
  -F "manifest=<$WORK/group-manifest.json" \
  -F "archive=@$SAMPLE_ARCHIVE;type=application/gzip"

step "9. proto builds stay in the primary (local) store"
stores="$(asset_stores proto-hosted)"
case "$stores" in "" | local) ;; *) fail "9: proto-hosted assets are in '$stores', expected local" ;; esac

step "11. Gradle fetchProtos through proto-group with a group-only token resolves hosted and mirrored bundles"
rm -rf "$CONSUMER/build/weaver"
gradle_run "$CONSUMER" "$URL" "$TOKEN_GROUP" fetchProtos -PweaverRepositories=proto-group \
  -PweaverDependencies=dev.smoke:sample:1.0.0,dev.upstream:base:1.0.0 || fail "11: fetchProtos through proto-group failed"
expect_contains 'message Hello' "$(fetched_file "$CONSUMER/build/weaver/protos" smoke/v1/hello.proto)"
expect_contains 'message Base' "$(fetched_file "$CONSUMER/build/weaver/protos" base/v1/base.proto)"

step "12. snapshot: two builds upstream, the pinned build fetched through proto-mirror matches the resolve answer"
SNAPSHOT=1.1.0-SNAPSHOT
gradle_run "$FIXTURES/upstream-sample" "$UPSTREAM_URL" "$UPSTREAM_TOKEN" publishProtos -PsampleVersion="$SNAPSHOT" ||
  fail "12: first snapshot publish failed"
SECOND="$(fresh_dir snapshot-src)"
cp -r "$FIXTURES/upstream-sample/src/main/proto/." "$SECOND/"
printf '\nmessage BaseV2 {\n  string id = 1;\n}\n' >>"$SECOND/base/v1/base.proto"
gradle_run "$FIXTURES/upstream-sample" "$UPSTREAM_URL" "$UPSTREAM_TOKEN" publishProtos -PsampleVersion="$SNAPSHOT" \
  -PprotoSource="$SECOND" || fail "12: second snapshot publish failed"
resolve_body="{\"repositories\":[\"proto-upstream\"],\"dependencies\":[\"dev.upstream:base:${SNAPSHOT}\"]}"
expect_status 200 POST "${UPSTREAM_URL}/api/v1/resolve" -H "Authorization: Bearer ${UPSTREAM_TOKEN}" \
  -H 'content-type: application/json' --data "$resolve_body"
cp "$WORK/last.body" "$WORK/resolve-upstream.json"
upstream_build="$(json_get "$WORK/resolve-upstream.json" artifacts.0.buildNumber)"
expect_at_least "12: upstream snapshot build number" "$upstream_build" 2
expect_status 200 POST "${URL}/api/v1/resolve" -H "Authorization: Bearer ${TOKEN_READ}" \
  -H 'content-type: application/json' --data "${resolve_body/proto-upstream/proto-mirror}"
cp "$WORK/last.body" "$WORK/resolve-mirror.json"
mirror_build="$(json_get "$WORK/resolve-mirror.json" artifacts.0.buildNumber)"
mirror_sha="$(json_get "$WORK/resolve-mirror.json" artifacts.0.sha256)"
mirror_archive="$(json_get "$WORK/resolve-mirror.json" artifacts.0.archiveUrl)"
[ "$mirror_build" = "$upstream_build" ] || fail "12: proto-mirror resolved build $mirror_build, upstream has $upstream_build"
[ "$mirror_sha" = "$(json_get "$WORK/resolve-upstream.json" artifacts.0.sha256)" ] ||
  fail "12: proto-mirror resolved sha256 $mirror_sha, upstream answered another"
case "$mirror_archive" in "${URL}/api/v1/repos/proto-mirror/"*"build=${mirror_build}"*) ;;
  *) fail "12: archive URL $mirror_archive is not a pinned proto-mirror URL under ${URL}" ;; esac
expect_status 200 GET "$mirror_archive" -H "Authorization: Bearer ${TOKEN_READ}"
got_sha="$(sha256sum "$WORK/last.body" | cut -d' ' -f1)"
[ "$got_sha" = "$mirror_sha" ] || fail "12: the pinned archive has sha256 $got_sha, resolve answered $mirror_sha"
DIR="$(cli_project proto-mirror "dev.upstream:base:${SNAPSHOT}")"
weaver_fetch "$DIR" "$TOKEN_READ" || fail "12: weaver fetch of the snapshot through proto-mirror failed"
expect_contains 'message BaseV2' "$(fetched_file "$DIR/protos" base/v1/base.proto)"

step "13. Gradle publish to proto-group fails with 405; a token without read on proto-group gets not_found"
expect_fail 'method_not_allowed|405' gradle_run "$FIXTURES/gradle-sample" "$URL" "$TOKEN_WRITE" publishProtos \
  -PpublishRepository=proto-group
DIR="$(cli_project proto-group dev.smoke:sample:1.0.0)"
expect_fail 'dev.smoke:sample:1.0.0 was not found' weaver_fetch "$DIR" "$TOKEN_NONE"
expect_status 404 POST "${URL}/api/v1/resolve" -H "Authorization: Bearer ${TOKEN_NONE}" -H 'content-type: application/json'   --data '{"repositories":["proto-group"],"dependencies":["dev.smoke:sample:1.0.0"]}'
expect_contains '"not_found"' "$WORK/last.body"

step "14. search finds dev.smoke:sample in proto-hosted for a reader and not for a token without permissions"
search_url="${URL}/api/trpc/search.query?input=$(node -e 'process.stdout.write(encodeURIComponent(JSON.stringify({ json: { q: "dev.smoke sample", format: "proto" } })))')"
expect_status 200 GET "$search_url" -H "Authorization: Bearer ${TOKEN_READ}"
expect_contains '"repository":"proto-hosted","via":null,"format":"proto","kind":"hosted","namespace":"dev.smoke","name":"sample"' "$WORK/last.body"
# The copy in proto-public is visible to everyone; the private one must not be.
expect_status 200 GET "$search_url" -H "Authorization: Bearer ${TOKEN_NONE}"
expect_contains '"repository":"proto-public"' "$WORK/last.body"
if grep -q '"repository":"proto-hosted"' "$WORK/last.body"; then
  fail "14: TOKEN_NONE sees dev.smoke:sample in proto-hosted: $(head -c 600 "$WORK/last.body")"
fi

echo "E2E proto OK"
