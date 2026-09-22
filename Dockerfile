FROM node:22.22.0-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22.22.0-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV FLOURISH_DATA_DIR=/app/data
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 flourish && mkdir -p /app/data && chown flourish:nodejs /app/data
COPY --from=builder --chown=flourish:nodejs /app/public ./public
COPY --from=builder --chown=flourish:nodejs /app/.next/standalone ./
COPY --from=builder --chown=flourish:nodejs /app/.next/static ./.next/static
USER flourish
EXPOSE 3000
CMD ["node", "server.js"]
