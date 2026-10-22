# Platform checks (sourced by run.sh): the worker runs a maintenance job, the public pages render,
# and every format is installed. Uses URL and the lib.sh helpers; prints `E2E platform OK`.

step "the worker completes an evict:all job"
# Enqueued with @weaver/jobs (the web app's code path) against the stack's Valkey.
e2e_compose exec -T -w /app/apps/worker worker node --input-type=module -e '
import { createQueue, producerConnection } from "@weaver/jobs";
const queue = createQueue(producerConnection(process.env.VALKEY_URL));
try {
  const job = await queue.add("evict:all", { kind: "evict:all" });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await job.getState();
    if (state === "completed") { console.log(`evict:all job ${job.id} completed`); break; }
    if (state === "failed") { await job.refresh?.(); throw new Error(`evict:all job ${job.id} failed: ${job.failedReason}`); }
    if (Date.now() > deadline) throw new Error(`evict:all job ${job.id} still ${state} after 60s`);
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await queue.close();
}
' || fail "worker: the evict:all job did not complete"

step "public pages"
for path in / /docs /sitemap.xml /opengraph-image /og/docs /api/health; do
  expect_status 200 GET "${URL}${path}"
done
expect_status 200 GET "${URL}/opengraph-image"
expect_header 'content-type' '^image/png'
expect_status 200 GET "${URL}/api/health"
expect_contains '"ok":true' "$WORK/last.body"

step "the docker registry challenges anonymous clients with a realm under ${URL}"
expect_status 401 GET "${URL}/v2/"
expect_header 'www-authenticate' "realm=\"${URL}/"

step "every format is installed"
for path in /maven/ /npm/; do
  status="$(curl -sS -o "$WORK/last.body" -w '%{http_code}' "${URL}${path}")" || fail "GET ${path}: curl failed"
  [ "$status" != "501" ] || fail "GET ${path}: 501, the format is not installed: $(head -c 300 "$WORK/last.body")"
done

echo "E2E platform OK"
