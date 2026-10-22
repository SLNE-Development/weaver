# syntax=docker/dockerfile:1
# One image for both processes: `web` (Next.js standalone server) and `worker` (BullMQ worker).
# Select the process with the container command (see docker/entrypoint.sh).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- base: node + pnpm via corepack (version comes from package.json "packageManager") ----
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- pruner: reduce the monorepo to what web + worker need ----
FROM base AS pruner
COPY . .
# The turbo version comes from the root package.json, so it is pinned in one place.
RUN npm install --global "turbo@$(node -p "require('./package.json').devDependencies.turbo")" \
 && turbo prune web @weaver/worker --docker

# ---- builder: install, build both apps, assemble the runtime tree under /out ----
FROM base AS builder
# Dependency layer: only manifests + lockfile, so source edits do not bust the install cache.
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
# The env schema (t3-env) must not run at build time; real values arrive at runtime.
ENV SKIP_ENV_VALIDATION=1
RUN pnpm turbo run build --filter=web --filter=@weaver/worker

# Runtime tree:
#   /out/app            Next standalone server (apps/web/server.js), static assets, public/
#   /out/app/apps/worker  self-contained worker (dist + prod node_modules), via `pnpm deploy`
#   /out/migrate        self-contained @weaver/db (dist + drizzle migrations + prod node_modules)
RUN mkdir -p /out/app \
 && cp -r apps/web/.next/standalone/. /out/app/ \
 && mkdir -p /out/app/apps/web/.next \
 && cp -r apps/web/.next/static /out/app/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -r apps/web/public /out/app/apps/web/public; fi
# Proto validation runs buf from its per-platform package (@bufbuild/buf-linux-x64 / -aarch64),
# which pnpm installs for the build platform only and Next traces into the standalone output
# (next.config.ts outputFileTracingIncludes). Fail the build if that binary is missing or not executable.
RUN set -e; \
    bin="$(ls /out/app/node_modules/.pnpm/@bufbuild+buf-linux-*/node_modules/@bufbuild/buf-linux-*/bin/buf)"; \
    test -x "$bin"; \
    test -e /out/app/node_modules/.pnpm/@bufbuild+buf@*/node_modules/@bufbuild/buf/package.json; \
    "$bin" --version
# `pnpm deploy` packs with npm-packlist, which falls back to .gitignore (it lists dist/): drop it first.
RUN rm -f .gitignore \
 && pnpm --filter=@weaver/worker deploy --legacy --prod /out/app/apps/worker \
 && pnpm --filter=@weaver/db deploy --legacy --prod /out/migrate
COPY docker/migrate.mjs /out/migrate/run.mjs

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    STORAGE_LOCAL_PATH=/data/storage
WORKDIR /app
# `node` (uid 1000) ships with the base image.
COPY --from=builder --chown=node:node /out/app/ /app/
COPY --from=builder --chown=node:node /out/migrate/ /app/migrate/
RUN mkdir -p /data/storage && chown -R node:node /data
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/healthcheck.sh
USER node
EXPOSE 3000
VOLUME ["/data/storage"]
# Command-aware: HTTP /api/health for `web`, process liveness for `worker`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
