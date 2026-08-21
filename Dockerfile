FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

# sqlite3 and bcrypt may need to compile native modules. Building them on the
# same Debian release used at runtime prevents C library version mismatches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./server/
RUN npm_config_build_from_source=true npm --prefix server ci --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/server/node_modules ./server/node_modules
COPY . .

EXPOSE 8080
CMD ["node", "server/start_server.js"]
