FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production LUMINA_DATA=/data LUMINA_RESTART=1 NODE_OPTIONS=--openssl-legacy-provider
# The first start creates a self-signed certificate and serves HTTPS on 8443 (80 redirects to it); change this in the UI.
ENV PORT=8443 LUMINA_TLS=auto LUMINA_HTTP_REDIRECT_PORT=8080
USER node
VOLUME /data
EXPOSE 8443 8080
CMD ["node", "packages/core/dist/index.js"]
