# Multi stage. `dev` runs the Vite dev server, `prod` serves the built bundle
# through nginx. Compose picks a target, so both live in one file.

# ------------------------------------------------------------------ base deps
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache wget
COPY package*.json ./
RUN npm ci || npm install

# ------------------------------------------------------------------ dev
FROM deps AS dev
COPY . .
EXPOSE 4090
# host 0.0.0.0 so the container is reachable from outside it. The rest of the
# dev server config, including allowedHosts and the HMR client port, is in
# vite.config.js where it can carry an explanation.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4090"]

# ------------------------------------------------------------------ build
FROM deps AS build
COPY . .
# No API URL is baked in here. The client reads window.location.hostname at
# page load, which is what lets the same bundle work on any address the host
# picks up. See .claude/guardrails/ports-and-networking.md.
RUN npm run build

# ------------------------------------------------------------------ prod
FROM nginx:1.27-alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 4091
CMD ["nginx", "-g", "daemon off;"]
