#!/usr/bin/env bash
# Verify a downloaded release with the trusted code already installed, then and
# only then unpack it and hand control to that release's existing installer.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ALLOW_UNSIGNED=0
TARBALL=
for arg in "$@"; do
  case "$arg" in
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --help|-h) echo "Usage: sudo $0 [--allow-unsigned] /path/to/jdrive-x.y.z.tgz"; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) [ -z "$TARBALL" ] || { echo "Give exactly one release tarball." >&2; exit 2; }; TARBALL=$arg ;;
  esac
done
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || { echo "Give the path to a JDrive release tarball." >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# Checked and unpacked from one private copy, so the file cannot be swapped between
# the check and the unpacking by anybody who can write where the download sits.
NAME=$(basename "$TARBALL")
install -m 600 "$TARBALL" "$STAGE/$NAME"
[ -f "$TARBALL.sig" ] && install -m 600 "$TARBALL.sig" "$STAGE/$NAME.sig"
[ -f "$TARBALL.sig.txt" ] && install -m 600 "$TARBALL.sig.txt" "$STAGE/$NAME.sig.txt"

if [ "$ALLOW_UNSIGNED" = 1 ]; then
  printf '\n  WARNING: --allow-unsigned skips JotNotes signature and checksum verification.\n  The archive will be trusted as supplied. This is for development only.\n\n' >&2
else
  node "$ROOT/server/tools/verify-release.js" "$STAGE/$NAME" || exit 1
fi

mkdir "$STAGE/tree"
tar -xzf "$STAGE/$NAME" -C "$STAGE/tree"
INSTALL=$(find "$STAGE/tree" -mindepth 4 -maxdepth 4 -type f -path '*/server/tools/install.sh' -print)
[ "$(printf '%s\n' "$INSTALL" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "The verified archive does not contain exactly one server/tools/install.sh." >&2; exit 1; }
bash "$INSTALL" --upgrade
