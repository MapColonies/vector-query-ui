#!/bin/sh
# Resolves config/ plus the environment into the served index.html before nginx
# starts. The bundle is static — the browser is what reads the configuration —
# so the environment has to be written into the page it loads. Same resolution
# as at build time: default.json, then {NODE_ENV}.json, then the variables
# mapped in config/custom-environment-variables.json.
#
# The nginx image runs every executable /docker-entrypoint.d/*.sh in order and
# only then execs nginx, so a bad config fails the container here, loudly.
set -e

node /app/scripts/build-config.mjs \
  --config-dir /app/config \
  --html /usr/share/nginx/html/index.html \
  --nginx /etc/nginx/app-proxy
