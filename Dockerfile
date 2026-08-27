FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config.example.yaml ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yaml

USER node

# No init shim is needed: the app spawns no child processes and handles SIGINT/SIGTERM itself.
CMD ["node", "src/index.js"]
