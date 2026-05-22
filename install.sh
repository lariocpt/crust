#!/usr/bin/env bash
# crust installer — curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash

set -euo pipefail

CRUST_DIR="${CRUST_DIR:-$HOME/.crust}"
REPO="${CRUST_REPO:-https://github.com/lariocpt/crust.git}"
BRANCH="${CRUST_BRANCH:-main}"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Clone or update crust
if [[ -d "$CRUST_DIR/.git" ]]; then
  say "Updating crust in $CRUST_DIR"
  git -C "$CRUST_DIR" pull --ff-only origin "$BRANCH"
else
  say "Cloning crust into $CRUST_DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO" "$CRUST_DIR"
fi

# 3. Dependencies
say "Installing dependencies"
( cd "$CRUST_DIR" && bun install )

# 3a. Compile bytecode binaries for this host
say "Compiling crust binaries (bytecode, host arch)"
mkdir -p "$CRUST_DIR/bin"
OS=$(uname -s | tr A-Z a-z)
RAW_ARCH=$(uname -m)
case "$RAW_ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) ARCH=$RAW_ARCH ;;
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
  Update:          curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
  Uninstall:       rm -rf ~/.crust ~/.config/crust

EOF
