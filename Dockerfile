# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY .husky/ .husky/
RUN npm ci || npm install
COPY tsconfig.json vite.config.ts index.html ./
# `scripts/` resolves config/ into index.html; `config/` is both its input and
# the defaults src/config.ts compiles in.
COPY scripts ./scripts
COPY config ./config
COPY src ./src
# Monaco makes the bundle (and its sourcemaps) big enough to blow Node's
# default ~2GB heap while rollup renders chunks.
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# ---- runtime stage ----
FROM nginx:1.27-alpine
# node is here only to re-render config.json from the environment on startup
RUN apk add --no-cache nodejs
COPY nginx-main.conf /etc/nginx/nginx.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY config /app/config
COPY scripts /app/scripts
COPY scripts/docker-entrypoint-config.sh /docker-entrypoint.d/10-app-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# The entrypoint rewrites index.html and the proxy config, and OpenShift runs
# the container as an arbitrary UID in group 0 — so what it writes to must be
# group-writable, not just root's. nginx's own writes go to /tmp, see
# nginx-main.conf.
# The CR strip is not paranoia: a checkout with core.autocrlf=true gives the
# script a "#!/bin/sh\r" shebang, and the kernel then reports the *script* as
# not found while looking for an interpreter by that name. .gitattributes
# prevents it at the source; this keeps the image correct either way.
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-app-config.sh \
    && chmod +x /docker-entrypoint.d/10-app-config.sh \
    && mkdir -p /etc/nginx/app-proxy \
    && chgrp -R 0 /usr/share/nginx/html /etc/nginx/app-proxy \
    && chmod -R g=u /usr/share/nginx/html /etc/nginx/app-proxy
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/healthz || exit 1
