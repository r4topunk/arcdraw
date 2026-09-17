# ArcDraw relayer image. Build from the repository root:
#   docker build -f services/relayer/Dockerfile -t arcdraw-relayer .
#   docker run --rm --env-file .env -v arcdraw-state:/data arcdraw-relayer
# The signer comes from RELAYER_PRIVATE_KEY at runtime (never baked into the image).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY services/relayer/package.json services/relayer/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@arcdraw/relayer..."
COPY packages/sdk packages/sdk
COPY services/relayer services/relayer
RUN pnpm --filter "@arcdraw/relayer..." build \
 && pnpm --filter @arcdraw/relayer deploy --legacy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production \
    RELAYER_STATE_FILE=/data/cursor.json \
    RELAYER_HEALTH_PORT=8787
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
