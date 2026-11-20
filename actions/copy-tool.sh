#!/usr/bin/env bash
# Amene l'outil dans le workspace du parc, en .scalingo-watcher.
#
# Une action distante est telechargee hors du workspace, sous _work/_actions.
# Or une composite ne resout `uses: ./...` que contre le workspace, et
# setup-node refuse un cache-dependency-path hors du workspace : les
# sous-actions et l'installation de Node attendent donc l'outil la ou le
# checkout des anciens workflows le posait.
#
# Lance par chaque action publique, avec GITHUB_ACTION_PATH sur son dossier.
# La variable et non l'expression github.action_path : dans un job conteneur,
# seule la variable est traduite vers le chemin du conteneur.
set -euo pipefail

root=$(cd "$GITHUB_ACTION_PATH/../.." && pwd -P)
dest="$GITHUB_WORKSPACE/.scalingo-watcher"

if [ -d "$dest" ] && [ "$(cd "$dest" && pwd -P)" = "$root" ]; then
  echo "outil deja en place dans .scalingo-watcher"
  exit 0
fi

rm -rf "$dest"
mkdir -p "$dest"
# Exclure .scalingo-watcher couvre le cas ou l'outil est lui-meme le workspace :
# sans cela, la copie se recopierait dans sa destination.
tar -C "$root" --exclude=./.git --exclude=./node_modules --exclude=./.scalingo-watcher -cf - . | tar -C "$dest" -xf -
echo "outil copie depuis $root"
