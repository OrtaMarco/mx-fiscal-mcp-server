# mx-fiscal-mcp-server — HTTP transport image.
#
# ⚠️ TEMPORARY: `mx-identifiers` is declared as `file:../mx-identifiers` until
# 1.0.0 lands on npm, and a `file:` path outside the build context cannot be
# resolved by `npm ci`. Until then, build with the PARENT directory as context
# so both repos are visible:
#
#   docker build -f mx-fiscal-mcp-server/Dockerfile.local -t mx-fiscal-mcp ..
#
# Once the dependency reads `"mx-identifiers": "^1.0.0"`, this file works as-is
# from the repo root:  docker build -t mx-fiscal-mcp .

# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
