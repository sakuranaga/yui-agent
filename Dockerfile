# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for Yui Agent.
#
# Two build targets:
#   - `dev`        (default): npm run dev、HMR 有効、ソースコードを volume mount で
#                   反映する開発用構成。docker-compose.yml がこれを使う。
#   - `production`: next build 済の standalone output を slim な runtime に乗せる。
#                   docker-compose.prod.yml または BUILD_TARGET=production で切替。
#
# Usage:
#   開発: docker compose up                                    (= dev target)
#   本番: docker compose -f docker-compose.prod.yml up -d      (= production target)
#       または: docker build --target production -t yui-agent .

# ============================================================================
# Stage: deps — npm install を独立 layer に (= source 変更で毎回走らない)
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ============================================================================
# Stage: dev — 開発用 (HMR + tsx + 全ソースを volume mount で上書き想定)
# ============================================================================
FROM node:22-alpine AS dev
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
CMD ["npm", "run", "dev"]

# ============================================================================
# Stage: build — next build (= production bundle 生成)
# ============================================================================
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js のテレメトリを無効化 (任意、bundle に影響なし)
ENV NEXT_TELEMETRY_DISABLED=1
# 本番ビルド時に存在しなくても build を通すため、ダミー env を渡す。
# 実 runtime では compose で正しい値を渡す。
ENV AUTH_TOKEN=build-time-placeholder
ENV ENCRYPTION_KEY=build-time-placeholder
RUN npm run build

# ============================================================================
# Stage: production — slim runtime (= next start)
# ============================================================================
FROM node:22-alpine AS production
WORKDIR /app
RUN apk add --no-cache libc6-compat tini
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

# 必要最小: package.json + node_modules (prod のみ) + .next + public + src/db (migrate 用)
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src/db ./src/db
COPY --from=build /app/next.config.* ./

# 非 root user で起動 (= 軽い hardening)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S yui -u 1001 -G nodejs && \
    chown -R yui:nodejs /app
USER yui

EXPOSE 3000
# tini で SIGTERM を正しく伝搬 (= graceful shutdown)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
