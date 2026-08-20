FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build \
    && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime-base

ARG SOURCE_REVISION=unknown
ENV NODE_ENV=production \
    SOURCE_REVISION=${SOURCE_REVISION}
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

FROM runtime-base AS document-preparer-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN rm -rf \
      /app/node_modules/@actual-app \
      /app/node_modules/better-sqlite3 \
      /app/node_modules/.pnpm/@actual-app+* \
      /app/node_modules/.pnpm/node_modules/@actual-app \
      /app/node_modules/.pnpm/better-sqlite3@* \
    && ! find /app/node_modules \
      \( -path '*@actual-app*' -o -path '*better-sqlite3*' \) \
      -print -quit | grep -q .

USER node
EXPOSE 4390

CMD ["node", "dist/document-preparer-service.js"]

FROM runtime-base AS finance-runtime

RUN rm -rf \
      /app/node_modules/@actual-app \
      /app/node_modules/.pnpm/@actual-app+* \
      /app/node_modules/.pnpm/node_modules/@actual-app \
      /app/node_modules/sharp \
      /app/node_modules/@img \
      /app/node_modules/.pnpm/node_modules/@img \
      /app/node_modules/.pnpm/sharp@* \
      /app/node_modules/.pnpm/@img+sharp-* \
    && ! find /app/node_modules \
      \( -path '*sharp*' -o -path '*@actual-app*' \) \
      -print -quit | grep -q .

RUN install -d -m 0750 -o node -g node /data

USER node
EXPOSE 4380
CMD ["node", "dist/main.js"]

FROM runtime-base AS actual-writer-runtime

RUN rm -rf \
      /app/node_modules/sharp \
      /app/node_modules/@img \
      /app/node_modules/.pnpm/node_modules/@img \
      /app/node_modules/.pnpm/sharp@* \
      /app/node_modules/.pnpm/@img+sharp-* \
    && ! find /app/node_modules -path '*sharp*' -print -quit | grep -q .

RUN install -d -m 0750 -o node -g node /data /writer-data

USER node
EXPOSE 4360
CMD ["node", "dist/actual-writer-service.js"]

FROM runtime-base AS actual-reader-runtime

RUN rm -rf \
      /app/node_modules/sharp \
      /app/node_modules/@img \
      /app/node_modules/.pnpm/node_modules/@img \
      /app/node_modules/.pnpm/sharp@* \
      /app/node_modules/.pnpm/@img+sharp-* \
    && ! find /app/node_modules -path '*sharp*' -print -quit | grep -q .

RUN install -d -m 0700 -o node -g node /reader-data

USER node
EXPOSE 4370
CMD ["node", "dist/actual-reader-service.js"]
