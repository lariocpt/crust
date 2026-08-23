#!/usr/bin/env bash
# crust — install the prebuilt binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
#
# Downloads the release binary for this OS/architecture, verifies it against the SHA256SUMS
# published alongside it, and installs it to ~/.local/bin. No clone, no Bun, no build.
#
# The checksum is not decoration: the file is verified while it is still a temp file with no
# execute bit, and only then moved into place. A truncated or tampered download must never be
# executable on disk, not even briefly.
#
# Options (also settable as environment variables):
#   --version <tag>   CRUST_VERSION       release tag to install, e.g. v0.2.0 (default: latest)
#   --dir <path>      CRUST_INSTALL_DIR   install directory (default: ~/.local/bin)
#   --repo <o/r>      CRUST_GITHUB_REPO   source repository (default: lariocpt/crust)
#                     CRUST_DOWNLOAD_BASE base URL holding the assets, for a mirror or a test
set -euo pipefail

REPO="${CRUST_GITHUB_REPO:-lariocpt/crust}"
VERSION="${CRUST_VERSION:-latest}"
INSTALL_DIR="${CRUST_INSTALL_DIR:-$HOME/.local/bin}"

say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    --repo)    REPO="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir=*)     INSTALL_DIR="${1#*=}"; shift ;;
    --repo=*)    REPO="${1#*=}"; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done
[ -n "$VERSION" ] || die "--version needs a value"
[ -n "$INSTALL_DIR" ] || die "--dir needs a value"

command -v curl >/dev/null 2>&1 || die "curl is required"

# sha256sum on GNU userland, shasum on macOS. Refusing to install unverified is the point, so
# there is no third branch that skips the check.
if command -v sha256sum >/dev/null 2>&1; then
  sha_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum to verify the download"
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux|darwin) ;;
  *) die "unsupported OS '$OS' — build from source: https://github.com/$REPO#build-from-source" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture '$(uname -m)' — build from source: https://github.com/$REPO#build-from-source" ;;
esac
ASSET="crust-${OS}-${ARCH}"

if [ -n "${CRUST_DOWNLOAD_BASE:-}" ]; then
  BASE="${CRUST_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/crust-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

say "Fetching checksums for $ASSET ($VERSION)"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" \
  || die "could not fetch $BASE/SHA256SUMS — is $VERSION a published release of $REPO?"

WANT=$(awk -v a="$ASSET" '$2 == a || $2 == "*" a { print $1 }' "$TMP/SHA256SUMS" | head -1)
if [ -z "$WANT" ]; then
  HAVE=$(awk '{ print $2 }' "$TMP/SHA256SUMS" | tr '\n' ' ')
  die "release $VERSION has no $ASSET (it has: $HAVE)"
fi

say "Downloading $ASSET"
curl -fSL --progress-bar "$BASE/$ASSET" -o "$TMP/$ASSET" || die "download failed: $BASE/$ASSET"

GOT=$(sha_of "$TMP/$ASSET")
[ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET
  expected $WANT
  got      $GOT"
say "Checksum verified"

mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
chmod 0755 "$TMP/$ASSET"
# Verified first, executable second, in place third.
mv -f "$TMP/$ASSET" "$INSTALL_DIR/crust" || die "cannot write $INSTALL_DIR/crust"

INSTALLED_VERSION=$("$INSTALL_DIR/crust" --version 2>/dev/null || echo "unknown")

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it:
    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc" ;;
esac

cat <<EOF

  $(printf '\033[1;32mcrust %s installed.\033[0m' "$INSTALLED_VERSION")

  Binary:     $INSTALL_DIR/crust
  REPL:       crust
  One-liner:  crust -c 'range(1,5) | (n => n * 2)'
  Docs:       https://github.com/$REPO#readme
  Uninstall:  rm $INSTALL_DIR/crust

EOF
