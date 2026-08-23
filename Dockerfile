FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# App code (node_modules already built above; .dockerignore keeps images/docs out)
COPY index.js ./
COPY src ./src
COPY public ./public

# Writable dir for config.json (mounted as a named volume; see compose)
RUN mkdir -p /app/config && chown node:node /app/config

ENV NODE_ENV=production \
    CONFIG_PATH=/app/config/config.json
EXPOSE 7000

# Liveness only (/healthz): /health would fail the container whenever the
# user's Jellyfin is unreachable, restarting a perfectly fine addon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
# --experimental-sqlite: node:22 gates node:sqlite behind the flag (no-op on 23+)
CMD ["node", "--experimental-sqlite", "index.js"]
