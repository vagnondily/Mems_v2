#!/usr/bin/env bash
# Lance l'API et l'interface ensemble, dans un seul terminal — pratique en
# Codespaces où ouvrir un second terminal n'est pas toujours évident.
# CTRL+C arrête les deux : le piège sur EXIT tue le groupe plutôt que de
# laisser le serveur tourner seul en arrière-plan après la fermeture du script.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

(cd server && npm run dev) &
SERVER_PID=$!
(cd web && npm run dev) &
WEB_PID=$!

trap 'kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true' EXIT INT TERM
wait
