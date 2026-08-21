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
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @opensales/core build && pnpm --filter @opensales/web build

FROM caddy:2.10.2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
