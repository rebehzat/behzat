#!/bin/sh
set -eu
BEHZAT_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BEHZAT_DEST=${BEHZAT_INSTALL_DIR:-"$HOME/.local/share/behzat"}
BEHZAT_BIN=${BEHZAT_BIN_DIR:-"$HOME/.local/bin"}
if [ ! -x "$BEHZAT_SOURCE/bin/behzat" ] || [ ! -d "$BEHZAT_SOURCE/runtime/node_modules" ]; then
  echo 'Run install.sh from an extracted Behzat release bundle.' >&2
  exit 1
fi
mkdir -p "$BEHZAT_DEST" "$BEHZAT_BIN"
cp -R "$BEHZAT_SOURCE/bin" "$BEHZAT_SOURCE/runtime" "$BEHZAT_SOURCE/licenses" "$BEHZAT_SOURCE/LICENSE" "$BEHZAT_SOURCE/THIRD_PARTY_NOTICES.md" "$BEHZAT_SOURCE/upstream.json" "$BEHZAT_DEST/"
chmod +x "$BEHZAT_DEST/bin/behzat"
ln -sfn "$BEHZAT_DEST/bin/behzat" "$BEHZAT_BIN/behzat"
"$BEHZAT_BIN/behzat" --version
echo "Installed $BEHZAT_BIN/behzat"
