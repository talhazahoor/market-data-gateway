# Multi-stage: the toolchain and dev dependencies never reach the final image.
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so this layer is cached unless dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve with production dependencies only, so no dev packages ship.
RUN npm ci --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Run as an unprivileged user. The node image ships a `node` user for this;
# a container process has no reason to be root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Hit the app's own health endpoint so the orchestrator restarts a process
# that is up but wedged, not just one that has exited.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so SIGTERM reaches node directly and the graceful shutdown in
# index.ts actually runs instead of the shell swallowing the signal.
CMD ["node", "dist/index.js"]
