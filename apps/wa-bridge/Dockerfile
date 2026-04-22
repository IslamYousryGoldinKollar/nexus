# syntax=docker/dockerfile:1
# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Baileys pulls libsignal as a git-hosted npm dep and some native
# modules (e.g. `sharp`) need python + build tools to compile.
RUN apk add --no-cache git python3 make g++

# Install dependencies
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

# Build
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy only what's needed at runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Auth/media hot cache (Fly volumes can mount here; data also lives in
# Supabase Storage so container restarts are safe even without a volume).
RUN mkdir -p /app/auth && chown -R node:node /app
USER node

CMD ["node", "--enable-source-maps", "dist/index.js"]
