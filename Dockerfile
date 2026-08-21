# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/provider-contracts/package.json packages/provider-contracts/package.json
COPY packages/provider-sdk-typescript/package.json packages/provider-sdk-typescript/package.json
COPY providers/mock-lab/package.json providers/mock-lab/package.json
COPY providers/example-sdk/package.json providers/example-sdk/package.json
COPY providers/example-schema-only-tax/package.json providers/example-schema-only-tax/package.json
COPY conformance/provider-platform/package.json conformance/provider-platform/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm -r --if-present build

FROM node:24.18.0-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
USER node

FROM runtime-base AS core-runtime
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations /app/apps/api/migrations
COPY --from=build --chown=node:node /app/apps/api/assets /app/apps/api/assets
COPY --from=build --chown=node:node /app/apps/worker/node_modules /app/apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/worker/package.json /app/apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/worker/dist /app/apps/worker/dist
COPY --from=build --chown=node:node /app/packages/core/package.json /app/packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist /app/packages/core/dist
COPY --from=build --chown=node:node /app/packages/provider-contracts/node_modules /app/packages/provider-contracts/node_modules
COPY --from=build --chown=node:node /app/packages/provider-contracts/package.json /app/packages/provider-contracts/package.json
COPY --from=build --chown=node:node /app/packages/provider-contracts/dist /app/packages/provider-contracts/dist
CMD ["node", "apps/api/dist/server.js"]

FROM runtime-base AS provider-runtime
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/providers/mock-lab/node_modules /app/providers/mock-lab/node_modules
COPY --from=build --chown=node:node /app/providers/mock-lab/package.json /app/providers/mock-lab/package.json
COPY --from=build --chown=node:node /app/providers/mock-lab/dist /app/providers/mock-lab/dist
COPY --from=build --chown=node:node /app/packages/provider-contracts/node_modules /app/packages/provider-contracts/node_modules
COPY --from=build --chown=node:node /app/packages/provider-contracts/package.json /app/packages/provider-contracts/package.json
COPY --from=build --chown=node:node /app/packages/provider-contracts/dist /app/packages/provider-contracts/dist
COPY --from=build --chown=node:node /app/packages/provider-sdk-typescript/node_modules /app/packages/provider-sdk-typescript/node_modules
COPY --from=build --chown=node:node /app/packages/provider-sdk-typescript/package.json /app/packages/provider-sdk-typescript/package.json
COPY --from=build --chown=node:node /app/packages/provider-sdk-typescript/dist /app/packages/provider-sdk-typescript/dist
CMD ["node", "providers/mock-lab/dist/server.js"]

# Backwards-compatible local Compose target. Two-host deployment files use the
# explicit core-runtime and provider-runtime targets through digest-bound images.
FROM core-runtime AS runtime
