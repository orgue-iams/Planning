#!/bin/bash
# Nettoie la base d'état Cursor (state.vscdb) après fermeture complète de Cursor (Cmd+Q).
# Sauvegarde déjà faite dans ~/Backups/ si vous avez lancé le diagnostic agent.

set -euo pipefail

GS="$HOME/Library/Application Support/Cursor/User/globalStorage"

if pgrep -xq Cursor; then
  echo "Erreur : Cursor est encore ouvert. Quittez avec Cmd+Q puis relancez ce script."
  exit 1
fi

BACKUP="$HOME/Backups/cursor-globalStorage-$(date +%Y%m%d-%H%M%S)"
echo "Sauvegarde de secours → $BACKUP"
mkdir -p "$HOME/Backups"
cp -a "$GS" "$BACKUP"

echo "Suppression des fichiers d'état volumineux…"
rm -f "$GS/state.vscdb" \
      "$GS/state.vscdb.backup" \
      "$GS/state.vscdb-wal" \
      "$GS/state.vscdb-shm"

echo "Terminé. Relancez Cursor — l'historique chat local sera reconstruit à neuf."
du -sh "$GS"
