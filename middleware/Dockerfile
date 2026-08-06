FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wget tini

# Dependencies before source, so a code edit does not invalidate the install
# layer.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/.cache && chown -R node:node /app
USER node

EXPOSE 3090

# tini as PID 1 so SIGTERM reaches node and the process shuts down cleanly
# instead of being killed after the compose stop timeout.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
