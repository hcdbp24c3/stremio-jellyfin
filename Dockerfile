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

USER node
# --experimental-sqlite: node:22 gates node:sqlite behind the flag (no-op on 23+)
CMD ["node", "--experimental-sqlite", "index.js"]
