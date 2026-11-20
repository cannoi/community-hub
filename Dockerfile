# Community Hub 2.3.29 — P2P + Presence defaults with per-Hub public-port selection
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data \
    P2P_ENABLED=true \
    P2P_WS_GATEWAY=true \
    PRESENCE_SERVE=true \
    P2P_FIXED_SEEDS=http://14.176.78.46:8181 \
    PRESENCE_SEEDS=http://14.176.78.46:8181
WORKDIR /app
COPY --chown=node:node . .
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=true \
 && node -e "import('@libp2p/gossipsub').then(m=>{if(typeof (m.gossipsub||m.default)!=='function') throw new Error('gossipsub export missing'); console.log('GossipSub module OK')}).catch(e=>{console.error(e);process.exit(1)})"
RUN mkdir -p /app/data /app/data/uploads /app/data/keys \
 && chown -R node:node /app/data \
 && chmod +x /app/docker-entrypoint.sh
USER node
EXPOSE 8080/tcp
# No VOLUME here — anonymous volumes are often root-owned and break smoke as USER node.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
