FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY config.example.yaml ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yaml

USER node

# Use `docker run --init` or compose `init: true` for PID 1 reaping (avoids apk/tini TLS issues).
CMD ["node", "src/index.js"]
