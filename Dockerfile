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
# The server imports electron/google-health-service.cjs directly; it needs only
# node:crypto and global fetch, never Electron itself.
COPY package.json ./
COPY server ./server
COPY electron/google-health-service.cjs ./electron/google-health-service.cjs
COPY --from=build /app/dist-web ./dist-web
USER node
EXPOSE 42814
CMD ["node", "server/index.mjs"]
