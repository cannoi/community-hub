# Community Hub 2.x — Node built-ins for core + optional libp2p runtime for automatic P2P discovery.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node . .
# Install the exact direct libp2p versions declared in package.json. npm install also repairs the legacy incomplete lockfile.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
# persistent state (SQLite DB, identity keys, uploads) lives in /app/data — mount a volume here
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# `npm start` still works; running node directly lets the process receive SIGTERM for a graceful shutdown
CMD ["node", "server.js"]
