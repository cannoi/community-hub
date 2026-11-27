FROM oven/bun:1-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

FROM base AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

RUN useradd -u 10001 -m nodejs

COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs src/ ./src/
COPY --chown=nodejs:nodejs public/ ./public/
COPY --chown=nodejs:nodejs lib/ ./lib/
COPY --chown=nodejs:nodejs scripts/ ./scripts/
COPY --chown=nodejs:nodejs --from=deps /app/node_modules ./node_modules

RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data

USER nodejs
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server.js"]
