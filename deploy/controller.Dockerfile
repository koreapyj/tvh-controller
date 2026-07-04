# Build: docker build -f deploy/controller.Dockerfile -t tvh-controller .
# CI tests on the same Node major (.github/workflows/ci.yml) — currently
# node:26-alpine. pnpm is installed explicitly: corepack is no longer
# bundled with Node >= 25.
FROM node:26-alpine AS build
RUN npm install -g pnpm@9.15.1
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/controller/package.json packages/controller/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -r build

FROM node:26-alpine AS deps
RUN npm install -g pnpm@9.15.1
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/controller/package.json packages/controller/
RUN pnpm install --frozen-lockfile --prod

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    TVHC_CONFIG=/etc/tvhc/config.yaml \
    WEB_DIST_DIR=/app/web
# pnpm gives every workspace package its own node_modules of symlinks into
# the root .pnpm store — each one must be copied, or its runtime imports
# fail with ERR_MODULE_NOT_FOUND
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/controller/package.json ./packages/controller/package.json
COPY --from=deps /app/packages/controller/node_modules ./packages/controller/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/controller/dist ./packages/controller/dist
COPY --from=build /app/packages/web/dist ./web
EXPOSE 8080
USER node
CMD ["node", "packages/controller/dist/main.js"]
