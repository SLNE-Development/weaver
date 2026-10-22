# Maven end to end (sourced by run.sh): stock mvn and Gradle publish to hosted repositories (releases,
# snapshots, checksums, Gradle module metadata, signatures), resolve through a group and through
# mirrors with the cache off, on and with the upstream down, and get denied where they should.
# Uses the run.sh exports and the lib.sh helpers; prints `E2E maven OK`.
#
# mvn is the one on PATH, else Maven ${MAVEN} from Maven Central (checksum checked, cached under
# ${XDG_CACHE_HOME:-~/.cache}/weaver-e2e). Gradle is the version of gradle-plugin's wrapper. Both need a
# JDK 17+ on PATH. Every build gets a fresh local repository (-Dmaven.repo.local) or GRADLE_USER_HOME,
# so a client cache never hides a broken repository; only Maven's own plugins are copied in from a
# prewarmed local repository, which never holds a dev.weaver.e2e artifact.

FIX="$ROOT/scripts/e2e/fixtures/maven"
SETTINGS="$FIX/settings.xml"
DEP="org.apache.maven.plugins:maven-dependency-plugin:${MAVEN_DEPENDENCY_PLUGIN:?versions.env}"
REPOSILITE_URL="http://localhost:${E2E_REPOSILITE_PORT:-8081}/releases"
M="${URL}/maven"
E2E_PATH="dev/weaver/e2e"

# The artifact the mirrors are read with: preloaded into the stand-in (local) or on Maven Central (real).
if [ "$UPSTREAMS" = "local" ]; then
  UP_G=dev.weaver.e2e UP_A=upstream-lib UP_V=1.0.0
  MIRROR_DOWN='(status code|HTTP Status): 502'
else
  UP_G=org.apache.commons UP_A=commons-lang3 UP_V=3.17.0
  MIRROR_DOWN='Could not find artifact'
fi
UP_COORD="${UP_G}:${UP_A}:${UP_V}"

# Runs <cmd...> with its output in $WORK/last.out; fails with <what> and the output's tail when it fails.
run_logged() {
  local what="$1"
  shift
  "$@" >"$WORK/last.out" 2>&1 || fail "$what: $(tail -n 40 "$WORK/last.out")"
}

# --- clients ---------------------------------------------------------------------------------------

command -v java >/dev/null 2>&1 || fail "maven: needs a JDK 17+ (java) on PATH"

step "clients: mvn and Gradle"
# On Git Bash the sh launcher needs path conversion, which run.sh turns off; mvn.cmd does not.
mvn_launcher=mvn
command -v cygpath >/dev/null 2>&1 && mvn_launcher=mvn.cmd
if command -v "$mvn_launcher" >/dev/null 2>&1; then
  MVN="$mvn_launcher"
else
  maven_home="${XDG_CACHE_HOME:-$HOME/.cache}/weaver-e2e/apache-maven-${MAVEN:?versions.env}"
  command -v cygpath >/dev/null 2>&1 && maven_home="$(cygpath -m "$maven_home")"
  if [ ! -x "$maven_home/bin/mvn" ]; then
    archive="$WORK/apache-maven-${MAVEN}-bin.tar.gz"
    curl -fsSL -o "$archive" \
      "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN}/apache-maven-${MAVEN}-bin.tar.gz" ||
      fail "clients: downloading Maven ${MAVEN} failed"
    [ "$(sha512sum <"$archive" | cut -d' ' -f1)" = "${MAVEN_SHA512:?versions.env}" ] ||
      fail "clients: the Maven ${MAVEN} archive does not match MAVEN_SHA512"
    mkdir -p "$(dirname "$maven_home")"
    rm -rf "$maven_home.partial" && mkdir -p "$maven_home.partial"
    # Read from stdin: GNU tar takes a C:/ archive name for a remote host.
    tar -xz -C "$maven_home.partial" --strip-components=1 <"$archive" || fail "clients: unpacking Maven failed"
    rm -rf "$maven_home" && mv "$maven_home.partial" "$maven_home"
  fi
  MVN="$maven_home/bin/$mvn_launcher"
fi
"$MVN" -v || fail "clients: mvn -v failed"

# Gradle: the wrapper of gradle-plugin fetches its distribution into the normal Gradle home once; the
# flows run that distribution's launcher with a fresh GRADLE_USER_HOME each.
gradle_version="$(sed -n 's/^distributionUrl=.*gradle-\(.*\)-bin\.zip$/\1/p' "$ROOT/gradle-plugin/gradle/wrapper/gradle-wrapper.properties")"
[ -n "$gradle_version" ] || fail "clients: no Gradle version in gradle-plugin's wrapper properties"
run_logged "clients: gradle-plugin/gradlew --version" "$ROOT/gradle-plugin/gradlew" -p "$ROOT/gradle-plugin" --version
GRADLE="$(ls -d "${GRADLE_USER_HOME:-$HOME/.gradle}"/wrapper/dists/gradle-"$gradle_version"-bin/*/gradle-"$gradle_version"/bin/gradle 2>/dev/null | head -n 1)"
[ -n "$GRADLE" ] && [ -f "$GRADLE" ] || fail "clients: the wrapper did not unpack Gradle $gradle_version"
echo "Gradle $gradle_version: $GRADLE"

# Copies fixture <name> to a fresh directory, sets its pom version to <version> when given, and echoes the copy.
fixture() {
  local dir
  dir="$(fresh_dir "$1")"
  cp -R "$FIX/$1/." "$dir/"
  if [ -n "${2:-}" ]; then
    sed -i "s|<version>[^<]*</version><!-- e2e:version -->|<version>$2</version><!-- e2e:version -->|" "$dir/pom.xml"
  fi
  echo "$dir"
}

# A file: URL for local directory <dir> (C:/... on Git Bash, /... on Linux).
file_url() {
  echo "file:///${1#/}"
}

# Fills local repository <dir> with Maven's own plugins for deploy and the dependency goals, resolved
# from Maven Central with settings <settings> (and, for a mirror, WEAVER_MIRROR_URL), then removes
# every dev.weaver.e2e file from it. Plugins are recorded under the repository id they came from, so
# a mirror setup needs its own prewarmed repository.
prewarm() {
  local repo="$1" settings="$2" target lib
  target="$(fresh_dir prewarm-target)"
  lib="$(fixture maven-lib)"
  WEAVER_USER=e2e WEAVER_PASS=none "$MVN" -B -ntp -s "$settings" -Dmaven.repo.local="$repo" -f "$lib/pom.xml" \
    deploy "$DEP:resolve" "$DEP:get" -Dartifact=dev.weaver.e2e:maven-lib:1.0.0 -Dtransitive=false \
    -DremoteRepositories="prewarm::default::$(file_url "$target")" -DaltDeploymentRepository="prewarm::$(file_url "$target")"
  rm -rf "$repo/dev"
}

step "prewarm Maven's plugins (from Maven Central)"
M2_SEED="$(fresh_dir m2-seed)"
run_logged "prewarm" prewarm "$M2_SEED" "$SETTINGS"
M2_SEED_MIRROR="$(fresh_dir m2-seed-mirror)"
WEAVER_MIRROR_URL="https://repo.maven.apache.org/maven2/" run_logged "prewarm (mirror)" prewarm "$M2_SEED_MIRROR" "$FIX/settings-mirror.xml"

# With real upstreams the upstream artifact is on Maven Central as well: the seeds must not hold it (a
# plugin may have pulled its pom in), and settings.xml's `central` becomes an empty directory, so every
# build that uses settings.xml can only get it through Weaver.
CENTRAL_ARGS=()
if [ "$UPSTREAMS" = "real" ]; then
  rm -rf "$M2_SEED/$(echo "$UP_G" | tr . /)/$UP_A/$UP_V" "$M2_SEED_MIRROR/$(echo "$UP_G" | tr . /)/$UP_A/$UP_V"
  CENTRAL_ARGS=(-De2e.central="$(file_url "$(fresh_dir no-central)")")
fi

# Echoes a fresh local repository holding only the prewarmed plugins of <seed> (default $M2_SEED).
fresh_m2() {
  local dir
  dir="$(fresh_dir m2)"
  cp -R "${1:-$M2_SEED}/." "$dir/"
  echo "$dir"
}

# mvn with settings.xml and a fresh local repository (kept in LAST_M2), sending <token> as the password.
mvn_as() {
  local token="$1"
  shift
  LAST_M2="$(fresh_m2)"
  WEAVER_USER=e2e WEAVER_PASS="$token" "$MVN" -B -ntp -s "$SETTINGS" -Dmaven.repo.local="$LAST_M2" "${CENTRAL_ARGS[@]}" "$@"
}

# Deploys fixture <name> as <version> to Weaver repository <repo> with <token>; extra mvn args follow.
# The built project stays in LAST_SRC.
deploy_as() {
  local name="$1" version="$2" repo="$3" token="$4"
  shift 4
  LAST_SRC="$(fixture "$name" "$version")"
  mvn_as "$token" -f "$LAST_SRC/pom.xml" deploy -DaltDeploymentRepository="weaver::${M}/${repo}/" "$@"
}

# `dependency:get` of <coordinate> from Weaver repository <repo> with <token>; extra mvn args follow.
get_as() {
  local coord="$1" repo="$2" token="$3"
  shift 3
  mvn_as "$token" "$DEP:get" -Dartifact="$coord" -Dtransitive=false -DremoteRepositories="weaver::default::${M}/${repo}/" "$@"
}

# Gradle with a fresh GRADLE_USER_HOME in project <dir>; extra args follow.
gradle_in() {
  local dir="$1"
  shift
  GRADLE_USER_HOME="$(fresh_dir gradle)" "$GRADLE" -p "$dir" --no-daemon --console=plain "$@"
}

# Echoes build.txt of the jar <file>.
jar_build() {
  unzip -p "$1" build.txt | tr -d '\r\n'
}

# GET <repo-path> under ${M} with Basic <token>, asserting status <code>.
maven_get() {
  local code="$1" path="$2" token="${3:-}"
  if [ -n "$token" ]; then
    expect_status "$code" GET "${M}/${path}" -u "e2e:${token}"
  else
    expect_status "$code" GET "${M}/${path}"
  fi
}

# Asserts that the body of the last request, trimmed, equals <want>.
expect_body() {
  local got
  got="$(tr -d ' \r\n' <"$WORK/last.body")"
  [ "$got" = "$1" ] || fail "expected body '$1', got '$(head -c 200 "$WORK/last.body")'"
}

# --- 1. preload the upstream -------------------------------------------------------------------------

if [ "$UPSTREAMS" = "local" ]; then
  step "preload upstream-lib and shared 1.0.0 into the stand-in upstream with mvn deploy"
  for name in upstream-lib shared-1; do
    src="$(fixture "$name")"
    run_logged "preload $name" mvn_as none -f "$src/pom.xml" deploy -DaltDeploymentRepository="reposilite::${REPOSILITE_URL}"
  done
fi

# --- 2. publish with mvn -----------------------------------------------------------------------------

step "mvn deploy maven-lib 1.0.0 and shared 2.0.0 to maven-hosted"
run_logged "deploy maven-lib 1.0.0" deploy_as maven-lib 1.0.0 maven-hosted "$TOKEN_WRITE"
LIB_SRC="$LAST_SRC"
run_logged "deploy shared 2.0.0" deploy_as shared-2 2.0.0 maven-hosted "$TOKEN_WRITE"

step "the jar's .sha1 (uploaded) and .sha512 (generated) match the local jar"
jar="$LIB_SRC/target/maven-lib-1.0.0.jar"
lib_dir="$E2E_PATH/maven-lib/1.0.0"
maven_get 200 "maven-hosted/$lib_dir/maven-lib-1.0.0.jar.sha1" "$TOKEN_READ"
expect_body "$(sha1sum <"$jar" | cut -d' ' -f1)"
maven_get 200 "maven-hosted/$lib_dir/maven-lib-1.0.0.jar.sha512" "$TOKEN_READ"
expect_body "$(sha512sum <"$jar" | cut -d' ' -f1)"

step "redeploying maven-lib 1.0.0 is a conflict; 1.0.1 deploys"
expect_fail '(status code|HTTP Status): 409' deploy_as maven-lib 1.0.0 maven-hosted "$TOKEN_WRITE"
run_logged "deploy maven-lib 1.0.1" deploy_as maven-lib 1.0.1 maven-hosted "$TOKEN_WRITE"

step "mvn -C (strict checksums) gets maven-lib 1.0.0 from maven-hosted"
run_logged "dependency:get -C" get_as dev.weaver.e2e:maven-lib:1.0.0 maven-hosted "$TOKEN_READ" -C
[ -f "$LAST_M2/$lib_dir/maven-lib-1.0.0.jar" ] || fail "dependency:get -C: maven-lib-1.0.0.jar is not in the local repository"

# --- 3. snapshots with mvn ---------------------------------------------------------------------------

step "mvn deploy maven-lib 1.1.0-SNAPSHOT twice"
for build in 1 2; do
  run_logged "deploy maven-lib 1.1.0-SNAPSHOT build $build" deploy_as maven-lib 1.1.0-SNAPSHOT maven-hosted "$TOKEN_WRITE" -Dbuild="$build"
done
maven_get 200 "maven-hosted/$E2E_PATH/maven-lib/1.1.0-SNAPSHOT/maven-metadata.xml" "$TOKEN_READ"
expect_contains '<buildNumber>2</buildNumber>' "$WORK/last.body"

# --- 4 + 12. publish with Gradle (module metadata, signatures, snapshots) ----------------------------

step "an in-memory signing key for Gradle"
GNUPGHOME="$(fresh_dir gnupg)"
# Git Bash's gpg starts its agent only with a POSIX home.
command -v cygpath >/dev/null 2>&1 && GNUPGHOME="$(cygpath -u "$GNUPGHOME")"
export GNUPGHOME
run_logged "gpg key" gpg --batch --pinentry-mode loopback --passphrase '' \
  --quick-gen-key 'Weaver E2E <e2e@weaver.invalid>' rsa2048 sign never
ORG_GRADLE_PROJECT_signingKey="$(gpg --batch --pinentry-mode loopback --passphrase '' --armor --export-secret-keys e2e@weaver.invalid)" ||
  fail "gpg: exporting the key failed"
export ORG_GRADLE_PROJECT_signingKey
gpgconf --kill gpg-agent >/dev/null 2>&1 || true

# Publishes gradle-lib <version> with build number <build> to maven-hosted; the project stays in LAST_SRC.
gradle_publish() {
  LAST_SRC="$(fixture gradle-lib)"
  gradle_in "$LAST_SRC" publish -PweaverUrl="${M}/maven-hosted/" -PweaverUsername=e2e -PweaverPassword="$TOKEN_WRITE" \
    -PlibVersion="$1" -Pbuild="$2"
}

step "Gradle publishes gradle-lib 1.0.0, signed, with its .module"
run_logged "gradle publish gradle-lib 1.0.0" gradle_publish 1.0.0 1
glib="$LAST_SRC"
glib_dir="$E2E_PATH/gradle-lib/1.0.0"
maven_get 200 "maven-hosted/$glib_dir/gradle-lib-1.0.0.module" "$TOKEN_READ"
[ "$(sha256sum <"$WORK/last.body" | cut -d' ' -f1)" = "$(sha256sum <"$glib/build/publications/maven/module.json" | cut -d' ' -f1)" ] ||
  fail "gradle publish: the served .module differs from build/publications/maven/module.json"
for file in gradle-lib-1.0.0.module.asc gradle-lib-1.0.0.pom.asc gradle-lib-1.0.0.jar.asc; do
  maven_get 200 "maven-hosted/$glib_dir/$file" "$TOKEN_READ"
  expect_contains '^-----BEGIN PGP SIGNATURE-----' "$WORK/last.body"
done
cmp -s "$WORK/last.body" "$glib/build/libs/gradle-lib-1.0.0.jar.asc" ||
  fail "gradle publish: the served jar signature differs from build/libs/gradle-lib-1.0.0.jar.asc"

step "Gradle publishes gradle-lib 2.0.0-SNAPSHOT twice"
for build in 1 2; do
  run_logged "gradle publish gradle-lib 2.0.0-SNAPSHOT build $build" gradle_publish 2.0.0-SNAPSHOT "$build"
done
maven_get 200 "maven-hosted/$E2E_PATH/gradle-lib/2.0.0-SNAPSHOT/maven-metadata.xml" "$TOKEN_READ"
expect_contains '<buildNumber>2</buildNumber>' "$WORK/last.body"

# --- 5 + 11. resolve through the group with mvn ------------------------------------------------------

app_as() {
  local token="$1"
  shift
  LAST_SRC="$(fixture maven-app)"
  mvn_as "$token" -f "$LAST_SRC/pom.xml" "$DEP:resolve" -Dupstream.groupId="$UP_G" -Dupstream.artifactId="$UP_A" \
    -Dupstream.version="$UP_V" "$@"
}

step "mvn resolves maven-lib 1.0.0 and ${UP_COORD} through maven-group with a group-only token"
run_logged "resolve through maven-group" app_as "$TOKEN_GROUP" -Dweaver.repo="${M}/maven-group/"
[ -f "$LAST_M2/$lib_dir/maven-lib-1.0.0.jar" ] || fail "group resolve: maven-lib-1.0.0.jar is missing"
[ -f "$LAST_M2/$(echo "$UP_G" | tr . /)/$UP_A/$UP_V/$UP_A-$UP_V.jar" ] || fail "group resolve: $UP_A-$UP_V.jar is missing"

step "mvn -U resolves maven-lib 1.1.0-SNAPSHOT build 2 through maven-group"
run_logged "resolve the snapshot through maven-group" app_as "$TOKEN_GROUP" -U -Dweaver.repo="${M}/maven-group/" -Dlib.version=1.1.0-SNAPSHOT
snap_jar="$LAST_M2/$E2E_PATH/maven-lib/1.1.0-SNAPSHOT/maven-lib-1.1.0-SNAPSHOT.jar"
[ -f "$snap_jar" ] || fail "snapshot resolve: maven-lib-1.1.0-SNAPSHOT.jar is missing"
[ "$(jar_build "$snap_jar")" = "2" ] || fail "snapshot resolve: got build $(jar_build "$snap_jar"), want 2"

step "maven-group merges shared's metadata from both members"
maven_get 200 "maven-group/$E2E_PATH/shared/maven-metadata.xml" "$TOKEN_GROUP"
expect_contains '<version>2.0.0</version>' "$WORK/last.body"
expect_contains '<release>2.0.0</release>' "$WORK/last.body"
[ "$UPSTREAMS" = "local" ] && expect_contains '<version>1.0.0</version>' "$WORK/last.body"

# --- 6. resolve through the group with Gradle --------------------------------------------------------

step "Gradle resolves gradle-lib's extra feature (.module) and 2.0.0-SNAPSHOT build 2 through maven-group"
gapp="$(fixture gradle-app)"
run_logged "gradle resolve through maven-group" gradle_in "$gapp" dependencies --configuration runtimeClasspath snapshotBuild \
  --refresh-dependencies -PweaverUrl="${M}/maven-group/" -PweaverUsername=e2e -PweaverPassword="$TOKEN_GROUP"
expect_contains 'dev\.weaver\.e2e:maven-lib:1\.0\.0' "$WORK/last.out"
expect_contains '^snapshot gradle-lib-2\.0\.0-.* build 2$' "$WORK/last.out"

# --- 7 + 13. mirrors: cache off, cache on, upstream down, offline ------------------------------------

up_jar="$(echo "$UP_G" | tr . /)/$UP_A/$UP_V/$UP_A-$UP_V.jar"

step "maven-mirror (cache off) serves ${UP_COORD} and stores nothing"
run_logged "get via maven-mirror" get_as "$UP_COORD" maven-mirror "$TOKEN_READ"
[ -f "$LAST_M2/$up_jar" ] || fail "maven-mirror: $UP_A-$UP_V.jar is missing"
[ "$(asset_count maven-mirror)" = "0" ] || fail "maven-mirror: has $(asset_count maven-mirror) assets, want 0"

if [ "$UPSTREAMS" = "real" ]; then
  step "rules: a path outside maven-mirror's allow list is 404 and never reaches Maven Central"
  bypass="$(cache_events maven-mirror bypass)"
  [ "$bypass" -ge 1 ] || fail "rules: the allowed ${UP_COORD} recorded no bypass on maven-mirror"
  maven_get 404 "maven-mirror/org/example/nope/1.0.0/nope-1.0.0.jar" "$TOKEN_READ"
  maven_get 404 "maven-mirror/org/example/nope/1.0.0/nope-1.0.0.pom" "$TOKEN_READ"
  [ "$(cache_events maven-mirror bypass)" = "$bypass" ] || fail "rules: org.example:nope reached the upstream of maven-mirror"
fi

step "maven-cached (cache on) serves ${UP_COORD} twice, cached in s3"
for _ in 1 2; do
  run_logged "get via maven-cached" get_as "$UP_COORD" maven-cached "$TOKEN_READ"
  [ -f "$LAST_M2/$up_jar" ] || fail "maven-cached: $UP_A-$UP_V.jar is missing"
done
[ "$(asset_count maven-cached cache)" -ge 1 ] || fail "maven-cached: no cached assets"
[ "$(asset_stores maven-cached)" = "s3" ] || fail "maven-cached: stores are '$(asset_stores maven-cached)', want s3"
[ "$(cache_events maven-cached hit)" -ge 1 ] || fail "maven-cached: no cache hit recorded"

step "upstream down: maven-cached still serves, maven-mirror fails"
upstream_down maven
run_logged "get via maven-cached, upstream down" get_as "$UP_COORD" maven-cached "$TOKEN_READ"
expect_fail "$MIRROR_DOWN" get_as "$UP_COORD" maven-mirror "$TOKEN_READ"
upstream_up maven

step "maven-cached offline serves its warm cache and nothing else"
sql "UPDATE repository SET config = jsonb_set(config, '{offline}', 'true') WHERE name = 'maven-cached'" >/dev/null
run_logged "get via offline maven-cached" get_as "$UP_COORD" maven-cached "$TOKEN_READ"
[ "$UPSTREAMS" = "local" ] && expect_fail 'Could not find artifact' get_as dev.weaver.e2e:shared:1.0.0 maven-cached "$TOKEN_READ"
sql "UPDATE repository SET config = jsonb_set(config, '{offline}', 'false') WHERE name = 'maven-cached'" >/dev/null

# --- 8. denial ---------------------------------------------------------------------------------------

step "denial: anonymous 401 with a Basic challenge, public 200, no permission 403, read-only deploy 403, group deploy 405"
maven_get 401 "maven-hosted/$lib_dir/maven-lib-1.0.0.pom"
expect_header 'www-authenticate' '^Basic'
run_logged "deploy maven-lib 1.0.0 to maven-public" deploy_as maven-lib 1.0.0 maven-public "$TOKEN_WRITE"
maven_get 200 "maven-public/$lib_dir/maven-lib-1.0.0.pom"
expect_contains '<artifactId>maven-lib</artifactId>' "$WORK/last.body"
maven_get 403 "maven-hosted/$lib_dir/maven-lib-1.0.0.pom" "$TOKEN_NONE"
expect_fail '(status code|HTTP Status): 403' deploy_as maven-lib 1.0.2 maven-hosted "$TOKEN_READ"
expect_fail '(status code|HTTP Status): 405' deploy_as maven-lib 1.0.2 maven-group "$TOKEN_WRITE"

# --- 9. storage --------------------------------------------------------------------------------------

step "hosted maven files stay in the primary (local) store"
[ "$(asset_stores maven-hosted)" = "local" ] || fail "maven-hosted: stores are '$(asset_stores maven-hosted)', want local"

# --- 14. one mirror for everything -------------------------------------------------------------------

step "settings.xml <mirrorOf>*</mirrorOf> to maven-group resolves hosted and upstream artifacts in one build"
mirror_app() {
  LAST_SRC="$(fixture maven-app)"
  LAST_M2="$(fresh_m2 "$M2_SEED_MIRROR")"
  WEAVER_USER=e2e WEAVER_PASS="$TOKEN_GROUP" WEAVER_MIRROR_URL="${M}/maven-group/" \
    "$MVN" -B -ntp -s "$FIX/settings-mirror.xml" -Dmaven.repo.local="$LAST_M2" -f "$LAST_SRC/pom.xml" "$DEP:resolve" \
    -Dweaver.repo="${M}/maven-hosted/" -Dupstream.groupId="$UP_G" -Dupstream.artifactId="$UP_A" -Dupstream.version="$UP_V"
}
run_logged "resolve through the mirrorOf * group" mirror_app
[ -f "$LAST_M2/$lib_dir/maven-lib-1.0.0.jar" ] || fail "mirrorOf *: maven-lib-1.0.0.jar is missing"
[ -f "$LAST_M2/$up_jar" ] || fail "mirrorOf *: $UP_A-$UP_V.jar is missing"

# --- 16. search --------------------------------------------------------------------------------------

step "search finds dev.weaver.e2e:maven-lib in maven-hosted for a read token, not for a token without permissions"
# Searches maven packages for maven-lib with <token>.
search_as() {
  expect_status 200 GET "${URL}/api/trpc/search.query" -G --data-urlencode 'input={"json":{"q":"maven-lib","format":"maven"}}'     -H "authorization: Bearer $1"
}
search_as "$TOKEN_READ"
expect_contains '"repository":"maven-hosted","via":null,"format":"maven","kind":"hosted","namespace":"dev\.weaver\.e2e","name":"maven-lib"' "$WORK/last.body"
search_as "$TOKEN_NONE"
# maven-public is readable by everyone, so only the private repositories must stay hidden.
if grep -qE '"repository":"maven-(hosted|group)"|"via":"maven-group"' "$WORK/last.body"; then
  fail "search: a token without permissions sees a private repository: $(head -c 400 "$WORK/last.body")"
fi

# --- 15. cleanup -------------------------------------------------------------------------------------

step "cleanup keep_last_snapshot_builds 1 keeps the newest of three snapshot builds"
for build in 1 2 3; do
  run_logged "deploy maven-lib 1.2.0-SNAPSHOT build $build" deploy_as maven-lib 1.2.0-SNAPSHOT maven-hosted "$TOKEN_WRITE" -Dbuild="$build"
done
snap_jars() {
  sql "SELECT count(*) FROM asset a JOIN repository r ON r.id = a.repository_id WHERE r.name = 'maven-hosted' AND a.path LIKE '$E2E_PATH/maven-lib/1.2.0-SNAPSHOT/%.jar'"
}
[ "$(snap_jars)" = "3" ] || fail "cleanup: $(snap_jars) snapshot jars before the cleanup, want 3"
sql "INSERT INTO cleanup_policy (repository_id, kind, value) SELECT id, 'keep_last_snapshot_builds', 1 FROM repository WHERE name = 'maven-hosted'" >/dev/null
e2e_compose exec -T -w /app/apps/worker worker node --input-type=module -e '
import { createQueue, producerConnection } from "@weaver/jobs";
const queue = createQueue(producerConnection(process.env.VALKEY_URL));
try {
  const job = await queue.add("cleanup:repo", { kind: "cleanup:repo", repository: "maven-hosted" });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await job.getState();
    if (state === "completed") { console.log(`cleanup:repo job ${job.id} completed`); break; }
    if (state === "failed") { await job.refresh?.(); throw new Error(`cleanup:repo job ${job.id} failed: ${job.failedReason}`); }
    if (Date.now() > deadline) throw new Error(`cleanup:repo job ${job.id} still ${state} after 60s`);
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await queue.close();
}
' || fail "cleanup: the cleanup:repo job did not complete"
[ "$(snap_jars)" = "1" ] || fail "cleanup: $(snap_jars) snapshot jars after the cleanup, want 1"
maven_get 200 "maven-hosted/$E2E_PATH/maven-lib/1.2.0-SNAPSHOT/maven-metadata.xml" "$TOKEN_READ"
expect_contains '<buildNumber>3</buildNumber>' "$WORK/last.body"
run_logged "dependency:get the cleaned snapshot" get_as dev.weaver.e2e:maven-lib:1.2.0-SNAPSHOT maven-hosted "$TOKEN_READ"
snap_jar="$LAST_M2/$E2E_PATH/maven-lib/1.2.0-SNAPSHOT/maven-lib-1.2.0-SNAPSHOT.jar"
[ -f "$snap_jar" ] || fail "cleanup: dependency:get did not fetch maven-lib-1.2.0-SNAPSHOT.jar"
[ "$(jar_build "$snap_jar")" = "3" ] || fail "cleanup: mvn got build $(jar_build "$snap_jar"), want 3"
gapp="$(fixture gradle-app)"
run_logged "gradle resolve the cleaned snapshot" gradle_in "$gapp" snapshotBuild -PsnapshotModule=dev.weaver.e2e:maven-lib:1.2.0-SNAPSHOT \
  -PweaverUrl="${M}/maven-hosted/" -PweaverUsername=e2e -PweaverPassword="$TOKEN_READ"
expect_contains '^snapshot maven-lib-1\.2\.0-.* build 3$' "$WORK/last.out"

echo "E2E maven OK"
