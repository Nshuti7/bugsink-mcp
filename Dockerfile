# --- Build stage --------------------------------------------------------
# Compiles TypeScript to plain JS. Kept separate from the runtime stage so
# the final image doesn't carry the TypeScript compiler, dev types, or
# pnpm's store around at runtime.
FROM node:20-slim AS build

# Corepack ships with Node 20+ and is how you get pnpm without a separate
# install step or baking a version mismatch into the image.
RUN corepack enable

WORKDIR /app

# Copy manifests first so this layer only invalidates (and re-runs install)
# when dependencies actually change, not on every source edit.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# --- Runtime stage -------------------------------------------------------
FROM node:20-slim AS runtime

RUN corepack enable
WORKDIR /app

# Only production dependencies in the final image.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# Bugsink instance URL and API token are supplied at deploy time (see
# docker-compose.yml / README.md) — never baked into the image.
ENV PORT=8787
EXPOSE 8787

# Runs as the non-root "node" user that the base image already provides,
# rather than root, since this process is reachable over the network.
USER node

CMD ["node", "dist/index.js"]
