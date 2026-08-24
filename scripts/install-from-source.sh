#!/usr/bin/env bash
# crust — build and install from a local clone.
#
#   git clone https://github.com/lariocpt/crust.git ~/.crust && ~/.crust/scripts/install-from-source.sh
#
# THIS IS THE DEVELOPER PATH, NOT THE INSTALL PATH.
# To just use crust, take a prebuilt binary — no clone and no Bun on the target host:
#
#   curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
#   npm i -g @lariocpt/crust
#
# What this script is for is a working copy you intend to change: it compiles for the host
# architecture (including architectures the release does not cover) and seeds the config.
set -euo pipefail

CRUST_DIR="${CRUST_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"

say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

[ -f "$CRUST_DIR/package.json" ] || die "run this from a crust checkout (no package.json in $CRUST_DIR)"

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Dependencies
say "Installing dependencies"
( cd "$CRUST_DIR" && bun install )

# 3. Compile for this host.
#
# --target is derived rather than assumed: releases cover linux and macOS on x64/arm64, so
# building locally is the supported route on anything else.
say "Compiling crust binaries (bytecode, host arch)"
mkdir -p "$CRUST_DIR/bin"
OS=$(uname -s | tr A-Z a-z)
RAW_ARCH=$(uname -m)
case "$RAW_ARCH" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)             ARCH=$RAW_ARCH ;;
esac
TARGET="bun-${OS}-${ARCH}"
( cd "$CRUST_DIR" && \
  bun build --compile --minify --bytecode --target="$TARGET" \
    --outfile bin/crust-bin src/index.ts )

# 4. Default config
mkdir -p "$HOME/.config/crust"
if [[ ! -f "$HOME/.config/crust/init.ts" ]]; then
  cp "$CRUST_DIR/skel/init.ts" "$HOME/.config/crust/init.ts"
  say "Wrote default config to ~/.config/crust/init.ts"
fi

# 5. Done. crust is a toolkit you call from bash/zsh/fish, not a login shell — so this
# deliberately does not register it in /etc/shells or suggest chsh.
CRUST_BIN="$CRUST_DIR/bin/crust"
chmod +x "$CRUST_BIN"

cat <<EOF

  $(printf '\033[1;32mcrust installed.\033[0m')

  REPL:       $CRUST_BIN
  One-liner:  $CRUST_BIN -c 'range(1,5) | (n => n * 2)'
  Config:     ~/.config/crust/init.ts
  Update:     git -C $CRUST_DIR pull && $CRUST_DIR/scripts/install-from-source.sh
  Uninstall:  rm -rf $CRUST_DIR ~/.config/crust

  To install on another machine, prefer the prebuilt binary:
    curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash

EOF
