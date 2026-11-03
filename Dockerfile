# Community Hub 2.x — zero runtime dependencies; needs Node >= 22.13 for the built-in node:sqlite module.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# nothing to `npm install`: the app uses only Node built-ins (smaller image, no native build, no supply-chain surface)
COPY --chown=node:node . .
# persistent state (SQLite DB, identity keys, uploads) lives in /app/data — mount a volume here
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# `npm start` still works; running node directly lets the process receive SIGTERM for a graceful shutdown
CMD ["node", "server.js"]
