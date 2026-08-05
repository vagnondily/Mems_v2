#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Amorçage automatique d'un Codespace MEMS.
#
#  Reprend exactement les étapes du « Démarrage rapide » du README (§1),
#  pour qu'ouvrir un Codespace donne une application utilisable sans
#  suivre la documentation à la main : .env avec des secrets générés,
#  dépendances des deux paquets, puis amorçage de la base.
#
#  Volontairement idempotent : relancer ce script (ou rouvrir le
#  Codespace) ne régénère pas les secrets ni ne réamorce une base déjà
#  peuplée — voir server/src/seed.js, qui refuse de reseeder sans
#  FORCE_SEED=1.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "→ Installation et démarrage de PostgreSQL dans le Codespace"
# L'image devcontainer n'embarque pas de serveur PostgreSQL : on l'installe et
# on le démarre dans le même conteneur, comme on ferait sur un poste local.
# Idempotent : `apt-get install` et la création du rôle/de la base sont sans
# effet si déjà faits (Codespace rouvert).
if ! command -v pg_lsclusters >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql >/dev/null
fi
sudo service postgresql start
until sudo -u postgres pg_isready -q; do sleep 1; done
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='mems') THEN
    CREATE ROLE mems LOGIN PASSWORD 'mems_codespace_pw';
  END IF;
END $$;
SELECT 'CREATE DATABASE mems OWNER mems' WHERE NOT EXISTS
  (SELECT FROM pg_database WHERE datname='mems')\gexec
SQL

if [ ! -f .env ]; then
  echo "→ Création de .env avec des secrets générés"
  cp .env.example .env
  # macOS/BSD sed et GNU sed diffèrent sur -i ; ici on est toujours sur
  # l'image devcontainer (Debian), donc GNU sed.
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 32)#" .env
  sed -i "s#^DATA_KEY=.*#DATA_KEY=$(openssl rand -hex 32)#" .env
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgres://mems:mems_codespace_pw@127.0.0.1:5432/mems#" .env
else
  echo "→ .env existe déjà, conservé tel quel"
fi

echo "→ Installation des dépendances (serveur puis interface)"
npm run install:all

echo "→ Migration et amorçage de la base (sans effet si déjà peuplée)"
# Le mot de passe administrateur initial ne s'affiche qu'une fois : consigné
# aussi dans ce journal (couvert par .gitignore, jamais commité) pour ne pas
# le perdre dans le flot de la création du Codespace.
npm run seed 2>&1 | tee server/.admin-credentials.log

cat <<'EOF'

═══════════════════════════════════════════════════════════════════════
 Amorçage terminé. Il reste à lancer les deux serveurs, dans deux
 terminaux distincts (l'un ne remplace pas l'autre) :

   npm run dev:server    # API — http://localhost:4000
   npm run dev:web       # interface — http://localhost:5173, onglet Ports

 Identifiants administrateur initiaux : voir server/.admin-credentials.log
 s'ils ont défilé plus haut dans le journal de création du Codespace.
═══════════════════════════════════════════════════════════════════════
EOF
