FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tini

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY config.example.yaml ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yaml
ENV GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
