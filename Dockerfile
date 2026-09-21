# Builds the static SPA and serves it from the stateless BFF in one image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server ./server
# The provider adapters are shared with the desktop app and need only
# node:crypto and global fetch, so they run in a plain Node process.
COPY providers ./providers
COPY --from=build /app/dist-web ./dist-web
USER node
EXPOSE 42814
CMD ["node", "server/index.mjs"]
