# Docker / OCI end to end (sourced by run.sh): docker push and pull, buildx multi-arch, helm OCI, podman,
# groups, mirrors with cache off/on and the upstream down, the root mirror as a daemon `registry-mirrors`
# entry (the `dind` service), denial, tag and manifest deletes, garbage collection, cleanup policies with
# cosign signatures, search, and with E2E_LARGE=1 a 2 GiB layer. Uses URL, HOST, WORK, ROOT, the TOKEN_*
# values and the lib.sh helpers; prints `E2E docker OK`.
#
# Needs Linux: buildkit and the dind daemon reach Weaver on localhost through host networking.
# Clients: docker (with buildx), podman, helm; cosign runs from COSIGN_IMAGE (versions.env).

[ "$(uname -s)" = "Linux" ] || fail "docker: docker e2e needs Linux (host networking)"
for tool in docker podman helm; do
  command -v "$tool" >/dev/null 2>&1 || fail "docker: $tool is not installed"
done
docker buildx version >/dev/null 2>&1 || fail "docker: docker buildx is not installed"

# The stand-in registry (local mode), as the host's docker daemon reaches it.
REGISTRY_HOST="localhost:${E2E_REGISTRY_PORT:-5000}"
# Accept header of a client that understands every manifest type.
MANIFEST_ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
BUILDER="${E2E_PROJECT:-weaver-e2e}-buildx"

# Each client gets its own config: logins of one step never leak into another.
export DOCKER_CONFIG
DOCKER_CONFIG="$(fresh_dir docker)"
PODMAN_AUTH="$(fresh_dir podman)/auth.json"
HELM_CONFIG="$(fresh_dir helm)/registry.json"

# Removes the buildx builder and the images this script tagged, whatever way the script ends.
docker_cleanup() {
  docker buildx rm --force "$BUILDER" >/dev/null 2>&1 || true
  docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null |
    grep -E "^(${HOST}|${REGISTRY_HOST})/" | xargs -r docker image rm -f >/dev/null 2>&1 || true
  podman image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null |
    grep -E "^${HOST}/" | xargs -r podman image rm -f >/dev/null 2>&1 || true
}
trap docker_cleanup EXIT
docker_cleanup

# Runs a maintenance job `<json>` (MaintenanceJobData) on the stack's worker and waits until it completed.
run_job() {
  # shellcheck disable=SC2016 # JavaScript source, expanded by node
  e2e_compose exec -T -w /app/apps/worker -e "E2E_JOB=$1" worker node --input-type=module -e '
import { createQueue, producerConnection } from "@weaver/jobs";
const data = JSON.parse(process.env.E2E_JOB);
const queue = createQueue(producerConnection(process.env.VALKEY_URL));
try {
  const job = await queue.add(data.kind, data);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const state = await job.getState();
    if (state === "completed") { console.log(`${data.kind} job ${job.id} completed`); break; }
    if (state === "failed") { await job.refresh?.(); throw new Error(`${data.kind} job ${job.id} failed: ${job.failedReason}`); }
    if (Date.now() > deadline) throw new Error(`${data.kind} job ${job.id} still ${state} after 120s`);
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await queue.close();
}
' || fail "job: $1 did not complete"
}

# Evaluates the JS expression <expr> over the JSON in <file> (as `j`) and echoes the result.
json_eval() {
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = eval(process.argv[2]); process.stdout.write(String(v ?? ""));' "$1" "$2" ||
    fail "json_eval: $2 over $1"
}

# Echoes the digest of manifest <repo>/<image>:<reference> (with token <token>).
manifest_digest() {
  expect_status 200 HEAD "${URL}/v2/$1/manifests/$2" -u "e2e:$3" -H "Accept: ${MANIFEST_ACCEPT}"
  tr -d '\r' <"$WORK/last.headers" | grep -i '^docker-content-digest:' | sed 's/^[^:]*:[[:space:]]*//'
}

# Echoes the digest of the first layer of <repo>/<image>:<reference>; an index resolves to its first real platform.
first_layer() {
  local repo="$1" ref="$2" token="$3" child
  expect_status 200 GET "${URL}/v2/${repo}/manifests/${ref}" -u "e2e:${token}" -H "Accept: ${MANIFEST_ACCEPT}"
  child="$(json_eval "$WORK/last.body" 'j.manifests ? j.manifests.find((m) => !m.platform || m.platform.os !== "unknown").digest : ""')"
  if [ -n "$child" ]; then
    expect_status 200 GET "${URL}/v2/${repo}/manifests/${child}" -u "e2e:${token}" -H "Accept: ${MANIFEST_ACCEPT}"
  fi
  json_eval "$WORK/last.body" 'j.layers[0].digest'
}

# Builds an image `FROM scratch` with one file per <content> argument (a.txt, b.txt, ...) and tags it <ref>.
build_scratch() {
  local ref="$1" dir i=0
  shift
  dir="$(fresh_dir ctx)"
  echo "FROM scratch" >"$dir/Dockerfile"
  for content in "$@"; do
    i=$((i + 1))
    printf '%s\n' "$content" >"$dir/file$i.txt"
    echo "COPY file$i.txt /" >>"$dir/Dockerfile"
  done
  docker build -q -t "$ref" "$dir" >/dev/null || fail "build: $ref"
}

# Removes every local tag of the image <ref> points to, so the next pull has to fetch it again.
forget_image() {
  local id
  id="$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null)" || return 0
  docker image rm -f "$id" >/dev/null 2>&1 || true
}

# Logs the docker CLI in to Weaver with <token>; the output must say Login Succeeded.
docker_login() {
  local out
  out="$(printf '%s' "$1" | docker login "$HOST" -u e2e --password-stdin 2>&1)" || fail "docker login: $out"
  printf '%s' "$out" | grep -q 'Login Succeeded' || fail "docker login: no 'Login Succeeded' in: $out"
}

# Runs <cmd...>, which must succeed, and echoes its combined output (for asserting on it).
must() {
  local out
  out="$("$@" 2>&1)" || fail "'$*' failed: $(printf '%s' "$out" | tail -n 20)"
  printf '%s\n' "$out"
}

RUN_ID="$(date +%s)-$$"

# --- buildx builder ----------------------------------------------------------------------------
# A docker-container builder on the host network; its buildkitd talks plain http to Weaver and the stand-in.
step "create the buildx builder"
{
  sed "s/localhost:3100/${HOST}/" "$ROOT/scripts/e2e/stand-ins/buildkitd.toml"
  printf '[registry."%s"]\n  http = true\n' "$REGISTRY_HOST"
} >"$WORK/buildkitd.toml"
must docker buildx create --name "$BUILDER" --driver docker-container --driver-opt network=host \
  --buildkitd-config "$WORK/buildkitd.toml" --bootstrap >/dev/null

# --- 1. Preload the upstream -------------------------------------------------------------------
if [ "$UPSTREAMS" = "local" ]; then
  step "preload the stand-in registry"
  printf '%s' 'e2e-registry-pass' | docker login "$REGISTRY_HOST" -u e2e --password-stdin >/dev/null 2>&1 ||
    fail "preload: docker login ${REGISTRY_HOST}"
  # Built and pushed by buildkit, so neither the image store nor the build cache of the local daemon holds
  # this content: pulls through the mirrors have to fetch all of it from Weaver.
  UP_CTX="$(fresh_dir upstream)"
  printf 'FROM scratch\nCOPY upstream.txt /\n' >"$UP_CTX/Dockerfile"
  printf 'upstream image of the weaver e2e run %s\n' "$RUN_ID" >"$UP_CTX/upstream.txt"
  must docker buildx build --builder "$BUILDER" --push -t "${REGISTRY_HOST}/e2e/upstream:1" "$UP_CTX" >/dev/null
  must docker buildx build --builder "$BUILDER" --push -t "${REGISTRY_HOST}/library/weaver-e2e-hello:1" \
    "$ROOT/scripts/e2e/fixtures/docker/hello" >/dev/null
  expect_status 200 HEAD "http://${REGISTRY_HOST}/v2/e2e/upstream/manifests/1" -u e2e:e2e-registry-pass -H "Accept: ${MANIFEST_ACCEPT}"
  UPSTREAM_DIGEST="$(tr -d '\r' <"$WORK/last.headers" | grep -i '^docker-content-digest:' | sed 's/^[^:]*:[[:space:]]*//')"
  [ -n "$UPSTREAM_DIGEST" ] || fail "preload: no digest for e2e/upstream:1"
  UP_IMAGE="e2e/upstream:1"
  ROOT_IMAGE="weaver-e2e-hello:1"
else
  UP_IMAGE="alpine:3.20.3"
  ROOT_IMAGE="alpine:3.20.3"
  UPSTREAM_DIGEST=""
fi

# --- 2. Log in and push ------------------------------------------------------------------------
step "docker login and push to docker-hosted"
docker_login "$TOKEN_WRITE"
docker build -q -t "${HOST}/docker-hosted/hello:1" "$ROOT/scripts/e2e/fixtures/docker/hello" >/dev/null || fail "build: hello"
must docker push "${HOST}/docker-hosted/hello:1" >/dev/null
expect_status 200 GET "${URL}/v2/docker-hosted/hello/tags/list" -u "e2e:${TOKEN_WRITE}"
expect_contains '"1"' "$WORK/last.body"
must docker push "${HOST}/docker-hosted/hello:1" >"$WORK/repush.out"
expect_contains 'Layer already exists' "$WORK/repush.out"
docker tag "${HOST}/docker-hosted/hello:1" "${HOST}/docker-public/hello:1"
must docker push "${HOST}/docker-public/hello:1" >/dev/null
HELLO_DIGEST="$(manifest_digest docker-hosted/hello 1 "$TOKEN_WRITE")"
[ -n "$HELLO_DIGEST" ] || fail "push: no Docker-Content-Digest for docker-hosted/hello:1"

# --- 11. Wrong token and logout ----------------------------------------------------------------
step "docker login with a wrong token fails; logout removes the credentials"
LOGIN_CONFIG="$(fresh_dir docker-login)"
expect_fail 'unauthorized' sh -c "printf '%s' 'wvr_wrong_token' | DOCKER_CONFIG='$LOGIN_CONFIG' docker login '$HOST' -u e2e --password-stdin"
printf '%s' "$TOKEN_READ" | DOCKER_CONFIG="$LOGIN_CONFIG" docker login "$HOST" -u e2e --password-stdin >/dev/null 2>&1 ||
  fail "login: read token"
expect_contains "\"${HOST}\"" "$LOGIN_CONFIG/config.json"
DOCKER_CONFIG="$LOGIN_CONFIG" must docker logout "$HOST" >/dev/null
if grep -q "\"${HOST}\"" "$LOGIN_CONFIG/config.json"; then
  fail "logout: ${HOST} is still in $(cat "$LOGIN_CONFIG/config.json")"
fi

# --- 3. Multi-arch with buildx -----------------------------------------------------------------
step "buildx multi-arch push to docker-hosted"
MULTI_CTX="$(fresh_dir multi)"
printf 'FROM scratch\nARG TARGETARCH\nCOPY multi.txt /\n' >"$MULTI_CTX/Dockerfile"
printf 'multi-arch image of the weaver e2e run %s\n' "$RUN_ID" >"$MULTI_CTX/multi.txt"
must docker buildx build --builder "$BUILDER" --platform linux/amd64,linux/arm64 --push \
  -t "${HOST}/docker-hosted/multi:1" "$MULTI_CTX" >/dev/null
must docker buildx imagetools inspect --builder "$BUILDER" "${HOST}/docker-hosted/multi:1" >"$WORK/imagetools.out"
expect_contains 'linux/amd64' "$WORK/imagetools.out"
expect_contains 'linux/arm64' "$WORK/imagetools.out"
must docker pull --platform linux/arm64 "${HOST}/docker-group/multi:1" >/dev/null
MULTI_LAYER="$(first_layer docker-hosted/multi 1 "$TOKEN_WRITE")"

# --- 4. Helm OCI -------------------------------------------------------------------------------
step "helm push to docker-hosted and pull through docker-group"
HELM_PKG="$(fresh_dir helm-pkg)"
must helm package "$ROOT/scripts/e2e/fixtures/docker/chart/weaver-e2e" -d "$HELM_PKG" >/dev/null
printf '%s' "$TOKEN_WRITE" | helm registry login "$HOST" --insecure -u e2e --password-stdin --registry-config "$HELM_CONFIG" >/dev/null 2>&1 ||
  fail "helm registry login"
must helm push "$HELM_PKG/weaver-e2e-0.1.0.tgz" "oci://${HOST}/docker-hosted/charts" --plain-http --registry-config "$HELM_CONFIG" >/dev/null
HELM_OUT="$(fresh_dir helm-out)"
must helm pull "oci://${HOST}/docker-group/charts/weaver-e2e" --version 0.1.0 --plain-http --registry-config "$HELM_CONFIG" -d "$HELM_OUT" >/dev/null
[ "$(sha256sum <"$HELM_PKG/weaver-e2e-0.1.0.tgz")" = "$(sha256sum <"$HELM_OUT/weaver-e2e-0.1.0.tgz")" ] ||
  fail "helm: the pulled chart differs from the pushed one"

# --- 12. Cross-repository mount ----------------------------------------------------------------
step "a multi-layer image pushed again to docker-public is mounted"
build_scratch "${HOST}/docker-hosted/layers:1" "layer one of ${RUN_ID}" "layer two of ${RUN_ID}" "layer three of ${RUN_ID}"
must docker push "${HOST}/docker-hosted/layers:1" >/dev/null
docker tag "${HOST}/docker-hosted/layers:1" "${HOST}/docker-public/layers:1"
must docker push "${HOST}/docker-public/layers:1" >"$WORK/mount.out"
expect_contains 'Mounted from' "$WORK/mount.out"

# --- 5. Group read with docker and podman ------------------------------------------------------
step "pull through docker-group with the group token (docker, podman)"
GROUP_CONFIG="$(fresh_dir docker-group)"
forget_image "${HOST}/docker-hosted/hello:1"
printf '%s' "$TOKEN_GROUP" | DOCKER_CONFIG="$GROUP_CONFIG" docker login "$HOST" -u e2e --password-stdin >/dev/null 2>&1 ||
  fail "login: group token"
DOCKER_CONFIG="$GROUP_CONFIG" must docker pull "${HOST}/docker-group/hello:1" >/dev/null
printf '%s' "$TOKEN_GROUP" | podman login --tls-verify=false --authfile "$PODMAN_AUTH" -u e2e --password-stdin "$HOST" >/dev/null 2>&1 ||
  fail "podman login: group token"
must podman pull --tls-verify=false --authfile "$PODMAN_AUTH" "${HOST}/docker-group/hello:1" >/dev/null
must podman pull --tls-verify=false --authfile "$PODMAN_AUTH" "${HOST}/docker-group/${UP_IMAGE}" >/dev/null

# --- 13. podman push ---------------------------------------------------------------------------
step "podman push to docker-hosted; a push to docker-mirror fails"
PODMAN_WRITE="$(fresh_dir podman-write)/auth.json"
printf '%s' "$TOKEN_WRITE" | podman login --tls-verify=false --authfile "$PODMAN_WRITE" -u e2e --password-stdin "$HOST" >/dev/null 2>&1 ||
  fail "podman login: write token"
podman tag "${HOST}/docker-group/hello:1" "${HOST}/docker-hosted/podman:1" || fail "podman tag"
must podman push --tls-verify=false --authfile "$PODMAN_WRITE" "${HOST}/docker-hosted/podman:1" >/dev/null
expect_status 200 GET "${URL}/v2/docker-hosted/podman/tags/list" -u "e2e:${TOKEN_WRITE}"
expect_contains '"1"' "$WORK/last.body"
podman tag "${HOST}/docker-group/hello:1" "${HOST}/docker-mirror/podman:1" || fail "podman tag"
expect_fail 'denied|unsupported|UNSUPPORTED|read-only' podman push --tls-verify=false --authfile "$PODMAN_WRITE" "${HOST}/docker-mirror/podman:1"

# --- 6. Mirror with cache off and on, upstream down --------------------------------------------
step "pull through docker-cached (cache on) and docker-mirror (cache off)"
# docker-cached first: the image's content is in no local store yet, so the daemon fetches all of it
# through the cache. The second pull goes through podman, whose `rmi` drops the content at once (the
# containerd image store of docker may keep it), so it really reads from the cache.
must docker pull "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null
forget_image "${HOST}/docker-cached/${UP_IMAGE}"
podman image rm -f "${HOST}/docker-group/${UP_IMAGE}" >/dev/null 2>&1 || true
PODMAN_READ="$(fresh_dir podman-read)/auth.json"
printf '%s' "$TOKEN_READ" | podman login --tls-verify=false --authfile "$PODMAN_READ" -u e2e --password-stdin "$HOST" >/dev/null 2>&1 ||
  fail "podman login: read token"
must podman pull --tls-verify=false --authfile "$PODMAN_READ" "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null
podman image rm -f "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null 2>&1 || true
must docker pull "${HOST}/docker-mirror/${UP_IMAGE}" >/dev/null
forget_image "${HOST}/docker-mirror/${UP_IMAGE}"
[ "$(asset_count docker-mirror)" = "0" ] || fail "docker-mirror: cache off but $(asset_count docker-mirror) assets"
[ "$(asset_count docker-cached)" -gt 0 ] || fail "docker-cached: nothing was cached"
[ "$(asset_stores docker-cached)" = "s3" ] || fail "docker-cached: assets in store '$(asset_stores docker-cached)', expected s3"
[ "$(asset_stores docker-hosted)" = "" ] || [ "$(asset_stores docker-hosted)" = "local" ] ||
  fail "docker-hosted: assets in store '$(asset_stores docker-hosted)', expected local"
[ "$(cache_events docker-cached hit)" -ge 1 ] || fail "docker-cached: no cache hit after the second pull"
if [ -n "$UPSTREAM_DIGEST" ]; then
  [ "$(manifest_digest docker-cached/e2e/upstream 1 "$TOKEN_READ")" = "$UPSTREAM_DIGEST" ] ||
    fail "docker-cached: the digest differs from the upstream's ${UPSTREAM_DIGEST}"
fi
if [ "$UPSTREAMS" = "real" ]; then
  [ "$(manifest_digest hub-mirror/alpine 3.20.3 "$TOKEN_READ")" = "$(manifest_digest hub-mirror/library/alpine 3.20.3 "$TOKEN_READ")" ] ||
    fail "hub-mirror: alpine and library/alpine resolve to different digests"
  step "rules: an image outside docker-mirror's allow list is 404 and never reaches Docker Hub"
  bypass="$(cache_events docker-mirror bypass)"
  [ "$bypass" -ge 1 ] || fail "rules: the allowed ${UP_IMAGE} recorded no bypass on docker-mirror"
  expect_status 404 GET "${URL}/v2/docker-mirror/library/busybox/manifests/latest" -u "e2e:${TOKEN_READ}" -H "Accept: ${MANIFEST_ACCEPT}"
  expect_status 404 GET "${URL}/v2/docker-mirror/busybox/manifests/latest" -u "e2e:${TOKEN_READ}" -H "Accept: ${MANIFEST_ACCEPT}"
  [ "$(cache_events docker-mirror bypass)" = "$bypass" ] || fail "rules: busybox reached the upstream of docker-mirror"
fi

step "upstream down: docker-cached keeps serving, docker-mirror fails"
upstream_down docker
must docker pull "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null
forget_image "${HOST}/docker-cached/${UP_IMAGE}"
# podman holds none of it locally, so every manifest and blob comes from the cache.
must podman pull --tls-verify=false --authfile "$PODMAN_READ" "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null
podman image rm -f "${HOST}/docker-cached/${UP_IMAGE}" >/dev/null 2>&1 || true
if [ "$UPSTREAMS" = "local" ]; then
  expect_fail 'unknown|502|[Bb]ad [Gg]ateway' docker pull "${HOST}/docker-mirror/${UP_IMAGE}"
else
  expect_fail 'not found|unknown' docker pull "${HOST}/docker-mirror/${UP_IMAGE}"
fi
upstream_up docker

# --- 7. Root mirror ----------------------------------------------------------------------------
step "the dind daemon pulls ${ROOT_IMAGE} through Weaver as its registry mirror"
e2e_compose --profile docker up -d --wait --wait-timeout 120 dind >/dev/null 2>&1 || fail "root mirror: dind did not become healthy"
DIND="$(e2e_compose --profile docker ps -q dind)"
[ -n "$DIND" ] || fail "root mirror: no dind container"
docker exec "$DIND" docker -H unix:///var/run/dind.sock pull "$ROOT_IMAGE" >"$WORK/dind.out" 2>&1 ||
  fail "root mirror: pull ${ROOT_IMAGE} failed: $(tail -n 20 "$WORK/dind.out")"
[ "$(cache_events hub miss)" -ge 1 ] || fail "root mirror: no cache miss on hub, the pull bypassed Weaver"
e2e_compose --profile docker stop dind >/dev/null 2>&1 || true

# --- 8. Denial ---------------------------------------------------------------------------------
step "anonymous requests get a Bearer challenge; missing permissions are denied"
expect_status 401 GET "${URL}/v2/docker-hosted/hello/manifests/1"
expect_header 'www-authenticate' "^Bearer realm=\"${URL}"
expect_header 'www-authenticate' 'service="'
expect_header 'www-authenticate' 'scope="repository:docker-hosted/hello:pull"'
ANON_CONFIG="$(fresh_dir docker-anon)"
expect_fail 'unauthorized|no basic auth credentials|pull access denied' env DOCKER_CONFIG="$ANON_CONFIG" docker pull "${HOST}/docker-hosted/hello:1"
READ_CONFIG="$(fresh_dir docker-read)"
printf '%s' "$TOKEN_READ" | DOCKER_CONFIG="$READ_CONFIG" docker login "$HOST" -u e2e --password-stdin >/dev/null 2>&1 ||
  fail "login: read token"
build_scratch "${HOST}/docker-hosted/denied:1" "denied image of ${RUN_ID}"
expect_fail 'denied' env DOCKER_CONFIG="$READ_CONFIG" docker push "${HOST}/docker-hosted/denied:1"
docker tag "${HOST}/docker-hosted/denied:1" "${HOST}/docker-group/denied:1"
expect_fail 'denied|unsupported|UNSUPPORTED' docker push "${HOST}/docker-group/denied:1"
forget_image "${HOST}/docker-public/hello:1"
DOCKER_CONFIG="$ANON_CONFIG" must docker pull "${HOST}/docker-public/hello:1" >/dev/null

# --- 17. Search --------------------------------------------------------------------------------
step "search finds docker-hosted/hello for the read token only"
SEARCH_URL="${URL}/api/trpc/search.query?input=$(node -e 'process.stdout.write(encodeURIComponent(JSON.stringify({ json: { q: "hello", format: "docker" } })))')"
expect_status 200 GET "$SEARCH_URL" -H "Authorization: Bearer ${TOKEN_READ}"
[ "$(json_eval "$WORK/last.body" 'j.result.data.json.hits.some((h) => h.repository === "docker-hosted" && h.name === "hello")')" = "true" ] ||
  fail "search: docker-hosted/hello missing for the read token: $(head -c 600 "$WORK/last.body")"
expect_status 200 GET "$SEARCH_URL" -H "Authorization: Bearer ${TOKEN_NONE}"
[ "$(json_eval "$WORK/last.body" 'j.result.data.json.hits.some((h) => h.repository === "docker-hosted")')" = "false" ] ||
  fail "search: the none token sees docker-hosted: $(head -c 600 "$WORK/last.body")"

# --- 14. Tag delete ----------------------------------------------------------------------------
step "deleting a tag removes only that tag"
docker tag "${HOST}/docker-public/hello:1" "${HOST}/docker-hosted/tagged:a"
docker tag "${HOST}/docker-public/hello:1" "${HOST}/docker-hosted/tagged:b"
must docker push "${HOST}/docker-hosted/tagged:a" >/dev/null
must docker push "${HOST}/docker-hosted/tagged:b" >/dev/null
TAGGED_DIGEST="$(manifest_digest docker-hosted/tagged a "$TOKEN_WRITE")"
expect_status 202 DELETE "${URL}/v2/docker-hosted/tagged/manifests/a" -u "e2e:${TOKEN_WRITE}"
expect_status 200 GET "${URL}/v2/docker-hosted/tagged/tags/list" -u "e2e:${TOKEN_WRITE}"
expect_contains '"b"' "$WORK/last.body"
if grep -q '"a"' "$WORK/last.body"; then fail "tag delete: tag a is still listed: $(cat "$WORK/last.body")"; fi
expect_status 404 HEAD "${URL}/v2/docker-hosted/tagged/manifests/a" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"
expect_status 200 HEAD "${URL}/v2/docker-hosted/tagged/manifests/${TAGGED_DIGEST}" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"
expect_status 200 HEAD "${URL}/v2/docker-hosted/tagged/manifests/b" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"

# --- 16. A pull by digest keeps the tag from delete_not_downloaded ------------------------------
step "a pull by digest keeps a tag from delete_not_downloaded"
build_scratch "${HOST}/docker-hosted/digested:1" "pulled by digest in ${RUN_ID}"
build_scratch "${HOST}/docker-hosted/stale:1" "never pulled in ${RUN_ID}"
must docker push "${HOST}/docker-hosted/digested:1" >/dev/null
must docker push "${HOST}/docker-hosted/stale:1" >/dev/null
DIGESTED_DIGEST="$(manifest_digest docker-hosted/digested 1 "$TOKEN_WRITE")"
sql "UPDATE docker_tag t SET updated_at = now() - interval '10 days' FROM repository r
     WHERE r.id = t.repository_id AND r.name = 'docker-hosted' AND t.image IN ('digested', 'stale')" >/dev/null
forget_image "${HOST}/docker-hosted/digested:1"
must docker pull "${HOST}/docker-hosted/digested@${DIGESTED_DIGEST}" >/dev/null
run_job '{"kind":"stats:rollup"}'
sql "INSERT INTO cleanup_policy (repository_id, kind, value) SELECT id, 'delete_not_downloaded', 5 FROM repository WHERE name = 'docker-hosted'" >/dev/null
run_job '{"kind":"cleanup:repo","repository":"docker-hosted"}'
sql "DELETE FROM cleanup_policy WHERE repository_id = (SELECT id FROM repository WHERE name = 'docker-hosted')" >/dev/null
expect_status 200 GET "${URL}/v2/docker-hosted/digested/tags/list" -u "e2e:${TOKEN_WRITE}"
expect_contains '"1"' "$WORK/last.body"
expect_status 404 HEAD "${URL}/v2/docker-hosted/stale/manifests/1" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"

# --- 15. cosign signatures survive delete_untagged_manifests and docker:gc ----------------------
step "a signed multi-arch image survives delete_untagged_manifests and docker:gc"
SIGNED_CTX="$(fresh_dir signed)"
printf 'FROM scratch\nCOPY signed.txt /\n' >"$SIGNED_CTX/Dockerfile"
printf 'signed image of the weaver e2e run %s\n' "$RUN_ID" >"$SIGNED_CTX/signed.txt"
must docker buildx build --builder "$BUILDER" --platform linux/amd64,linux/arm64 --push \
  -t "${HOST}/docker-hosted/signed:1" "$SIGNED_CTX" >/dev/null
SIGNED_DIGEST="$(manifest_digest docker-hosted/signed 1 "$TOKEN_WRITE")"
COSIGN_DIR="$(fresh_dir cosign)"
chmod 0777 "$COSIGN_DIR"
# cosign runs as a container on the host network; it reads the docker login of $DOCKER_CONFIG.
cosign() {
  docker run --rm --network host -u "$(id -u):$(id -g)" -e COSIGN_PASSWORD= -e DOCKER_CONFIG=/docker \
    -v "$DOCKER_CONFIG:/docker:ro" -v "$COSIGN_DIR:/keys" -w /keys "${COSIGN_IMAGE:?set in versions.env}" "$@"
}
must cosign generate-key-pair >/dev/null
# Key-based and offline: no transparency log (the run contacts no public service). cosign 3 attaches the
# signature as an OCI referrer of the image.
must cosign sign --yes --key /keys/cosign.key --allow-http-registry --allow-insecure-registry \
  --use-signing-config=false --tlog-upload=false "${HOST}/docker-hosted/signed@${SIGNED_DIGEST}" >/dev/null
expect_status 200 GET "${URL}/v2/docker-hosted/signed/referrers/${SIGNED_DIGEST}" -u "e2e:${TOKEN_WRITE}"
[ "$(json_eval "$WORK/last.body" 'j.manifests.length')" -ge 1 ] || fail "cosign: no referrer on the signed image: $(head -c 600 "$WORK/last.body")"
# A control: a manifest whose only tag is deleted, which the policy has to remove.
build_scratch "${HOST}/docker-hosted/orphan:1" "orphaned image of ${RUN_ID}"
must docker push "${HOST}/docker-hosted/orphan:1" >/dev/null
ORPHAN_DIGEST="$(manifest_digest docker-hosted/orphan 1 "$TOKEN_WRITE")"
expect_status 202 DELETE "${URL}/v2/docker-hosted/orphan/manifests/1" -u "e2e:${TOKEN_WRITE}"
# The policy counts whole days (at least one); age both images so it applies to them now.
sql "UPDATE docker_manifest m SET created_at = now() - interval '2 days' FROM repository r
     WHERE r.id = m.repository_id AND r.name = 'docker-hosted' AND m.image IN ('orphan', 'signed')" >/dev/null
sql "INSERT INTO cleanup_policy (repository_id, kind, value) SELECT id, 'delete_untagged_manifests', 1 FROM repository WHERE name = 'docker-hosted'" >/dev/null
run_job '{"kind":"cleanup:repo","repository":"docker-hosted"}'
sql "DELETE FROM cleanup_policy WHERE repository_id = (SELECT id FROM repository WHERE name = 'docker-hosted')" >/dev/null
expect_status 404 HEAD "${URL}/v2/docker-hosted/orphan/manifests/${ORPHAN_DIGEST}" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"
# docker:gc keeps everything used in the last 24 hours; age the links and blobs so it may collect now.
sql "UPDATE docker_blob_link SET created_at = now() - interval '2 days'" >/dev/null
sql "UPDATE docker_blob SET last_linked_at = now() - interval '2 days'" >/dev/null
run_job '{"kind":"docker:gc"}'
for platform in linux/amd64 linux/arm64; do
  forget_image "${HOST}/docker-hosted/signed:1"
  must docker pull --platform "$platform" "${HOST}/docker-hosted/signed:1" >/dev/null
done
expect_status 200 GET "${URL}/v2/docker-hosted/signed/referrers/${SIGNED_DIGEST}" -u "e2e:${TOKEN_WRITE}"
[ "$(json_eval "$WORK/last.body" 'j.manifests.length')" -ge 1 ] || fail "cleanup: the signature referrer is gone"
must cosign verify --key /keys/cosign.pub --allow-http-registry --allow-insecure-registry --insecure-ignore-tlog=true \
  "${HOST}/docker-hosted/signed:1" >/dev/null

# --- 9. Delete and GC --------------------------------------------------------------------------
step "deleting a manifest and running docker:gc frees its layer"
HELLO_LAYER="$(first_layer docker-hosted/hello 1 "$TOKEN_WRITE")"
# The containerd image store pushes an index (image plus attestation); its children are manifests of
# their own that keep the layer referenced, so delete them as well.
expect_status 200 GET "${URL}/v2/docker-hosted/hello/manifests/${HELLO_DIGEST}" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"
for child in $(json_eval "$WORK/last.body" '(j.manifests || []).map((m) => m.digest).join(" ")'); do
  expect_status 202 DELETE "${URL}/v2/docker-hosted/hello/manifests/${child}" -u "e2e:${TOKEN_WRITE}"
done
expect_status 202 DELETE "${URL}/v2/docker-hosted/hello/manifests/${HELLO_DIGEST}" -u "e2e:${TOKEN_WRITE}"
expect_status 404 HEAD "${URL}/v2/docker-hosted/hello/manifests/1" -u "e2e:${TOKEN_WRITE}" -H "Accept: ${MANIFEST_ACCEPT}"
sql "UPDATE docker_blob_link SET created_at = now() - interval '2 days'" >/dev/null
sql "UPDATE docker_blob SET last_linked_at = now() - interval '2 days'" >/dev/null
run_job '{"kind":"docker:gc"}'
expect_status 404 HEAD "${URL}/v2/docker-hosted/hello/blobs/${HELLO_LAYER}" -u "e2e:${TOKEN_WRITE}"
expect_status 200 HEAD "${URL}/v2/docker-hosted/multi/blobs/${MULTI_LAYER}" -u "e2e:${TOKEN_WRITE}"

# --- 10. A 2 GiB layer through the memory-capped app --------------------------------------------
if [ "${E2E_LARGE:-0}" = "1" ]; then
  step "push and pull a 2 GiB layer"
  LARGE_CTX="$(fresh_dir large)"
  head -c 2147483648 /dev/urandom >"$LARGE_CTX/large.bin" || fail "large: cannot write 2 GiB"
  printf 'FROM scratch\nCOPY large.bin /\n' >"$LARGE_CTX/Dockerfile"
  docker build -q -t "${HOST}/docker-hosted/large:1" "$LARGE_CTX" >/dev/null || fail "build: large"
  rm -f "$LARGE_CTX/large.bin"
  must docker push "${HOST}/docker-hosted/large:1" >/dev/null
  forget_image "${HOST}/docker-hosted/large:1"
  must docker pull "${HOST}/docker-hosted/large:1" >/dev/null
  forget_image "${HOST}/docker-hosted/large:1"
  [ "$(docker inspect -f '{{.State.OOMKilled}}' "$(e2e_compose ps -q app)")" = "false" ] || fail "large: the app was OOM-killed"
fi

echo "E2E docker OK"
