FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    MAX_UPLOAD_MB=200 \
    FILE_TTL_HOURS=6 \
    RATE_LIMIT=20

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY server.js ./server.js
RUN mkdir -p storage/uploads storage/outputs \
    && chown -R node:node /app

USER node
EXPOSE 4173
CMD ["node", "server.js"]
