# ── Étape 1 : compilation du frontend ────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── Étape 2 : dépendances du serveur ─────────────────────────────────
# `pg` est un client JavaScript pur — contrairement à better-sqlite3, plus
# aucun compilateur natif (python3/make/g++) n'est nécessaire ici.
FROM node:22-bookworm-slim AS deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# ── Étape 3 : image finale ───────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini : signal 1 propre. postgresql-client : pg_dump/pg_restore, utilisés par
# Paramètres → Administration → Sauvegarde et restauration (lib/sauvegarde.js).
RUN apt-get update && apt-get install -y --no-install-recommends tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist

# Le service ne tourne pas en root et n'écrit que dans son volume de données.
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
VOLUME ["/app/server/data"]
WORKDIR /app/server
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/index.js"]
