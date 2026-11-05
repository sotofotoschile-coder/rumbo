#!/bin/bash
# Instala las herramientas para generar los mapas offline y desarrollar la app web.
# Funciona en Mac Intel sin Homebrew y sin contraseña de administrador:
# todo queda dentro de tu carpeta personal (~/miniforge3 y ~/Herramientas).
# Uso: bash instalar_herramientas.sh [ruta/al/Miniforge3.sh ya descargado]
set -euo pipefail

TOOLS="$HOME/Herramientas"
BIN="$TOOLS/bin"
mkdir -p "$BIN"

# 1. Miniforge (conda-forge) -> ~/miniforge3
if [ ! -x "$HOME/miniforge3/bin/conda" ]; then
  INSTALLER="${1:-}"
  if [ -z "$INSTALLER" ]; then
    INSTALLER="$(mktemp -d)/Miniforge3.sh"
    curl -fsSL -o "$INSTALLER" \
      "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-x86_64.sh"
  fi
  bash "$INSTALLER" -b -p "$HOME/miniforge3"
fi
CONDA="$HOME/miniforge3/bin/conda"

# 2. Entorno "rumbo": Node (app web), osmium/pyosmium (datos OSM y grafo de rutas),
#    GDAL (curvas de nivel y relieve), tippecanoe (teselas de curvas)
if [ ! -d "$HOME/miniforge3/envs/rumbo" ]; then
  "$CONDA" create -y -n rumbo -c conda-forge \
    python=3.12 nodejs=22 osmium-tool pyosmium numpy gdal tippecanoe
fi

# 3. pmtiles CLI (recorta y empaqueta mapas .pmtiles)
if [ ! -x "$BIN/pmtiles" ]; then
  URL=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
    | grep -o 'https://[^"]*Darwin_x86_64[^"]*\.zip' | head -1)
  TMP=$(mktemp -d); curl -fsSL -o "$TMP/p.zip" "$URL"; unzip -oq "$TMP/p.zip" -d "$TMP"
  mv "$TMP/pmtiles" "$BIN/pmtiles"; chmod +x "$BIN/pmtiles"
fi

echo "Listo."
echo "  Entorno: $HOME/miniforge3/envs/rumbo"
echo "  pmtiles: $BIN/pmtiles"
