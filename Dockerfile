FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 && rm -rf /var/lib/apt/lists/* && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS finance-runtime
ARG SOURCE_REVISION=development
ENV NODE_ENV=production SOURCE_REVISION=${SOURCE_REVISION} FINANCE_CONFIG=/run/secrets/finance_config
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap poppler-utils util-linux tini && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chmod=755 scripts/entrypoint.sh /usr/local/bin/finance-entrypoint
USER node
EXPOSE 4380
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/finance-entrypoint"]
CMD ["node", "dist/main.js"]
