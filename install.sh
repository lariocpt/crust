#!/usr/bin/env bash
# crust — build and install from a local clone.
#
#   git clone git@github.com:lariocpt/crust.git ~/.crust && ~/.crust/install.sh
#
# THIS IS THE DEVELOPER PATH, NOT THE INSTALL PATH.
# It used to be a `curl … raw.githubusercontent.com/…/install.sh | bash` one-liner against a
# public repo. That stopped being possible when crust went private — raw.githubusercontent
# requires auth for a private repo, so a piped installer would fetch a 404 and run it. It
# also pointed at `lariocpt/crust`, an org that no longer holds this project.
#
# For installing crust on a machine, use the LAN artifact plane instead. It downloads the
# prebuilt binary Jenkins published, verifies its sha256, and needs neither a clone, nor a
# GitHub credential, nor Bun on the target host:
#
#   curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust
#   npm i -g crust --registry https://npm.in.drlario.org
#
# What this script is still good for is a working copy you intend to change: it compiles for
# the host architecture, seeds the config, and registers the shell.
set -euo pipefail

CRUST_DIR="${CRUST_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"

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
# --target is derived rather than assumed: the published LAN artifact is linux-x64 only, so
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
    --outfile bin/crust-bin src/index.ts && \
  bun build --compile --minify --bytecode --target="$TARGET" \
    --outfile bin/crust-test-fixture src/testFixture/cli.ts )

# 4. Default config
mkdir -p "$HOME/.config/crust"
if [[ ! -f "$HOME/.config/crust/init.ts" ]]; then
  cp "$CRUST_DIR/skel/init.ts" "$HOME/.config/crust/init.ts"
  say "Wrote default config to ~/.config/crust/init.ts"
fi

# 5. Register in /etc/shells (asks for sudo, skips if non-interactive)
CRUST_BIN="$CRUST_DIR/bin/crust"
chmod +x "$CRUST_BIN"
if ! grep -qxF "$CRUST_BIN" /etc/shells 2>/dev/null; then
  if [[ -t 0 ]]; then
    say "Adding crust to /etc/shells (needs sudo)"
    echo "$CRUST_BIN" | sudo tee -a /etc/shells >/dev/null
  else
    say "Skipping /etc/shells registration (non-interactive). Run: echo $CRUST_BIN | sudo tee -a /etc/shells"
  fi
fi

cat <<EOF

  $(printf '\033[1;32mcrust installed.\033[0m')

  Try it:          $CRUST_BIN
  COSMIC Terminal: Settings → Profiles → Command: $CRUST_BIN
  Set as login:    chsh -s $CRUST_BIN
  Config:          ~/.config/crust/init.ts
  Update:          git -C $CRUST_DIR pull && $CRUST_DIR/install.sh
  Uninstall:       rm -rf $CRUST_DIR ~/.config/crust

  To install on another machine, prefer the prebuilt binary:
    curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust

EOF
