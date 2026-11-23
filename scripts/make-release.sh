#!/usr/bin/env bash
# make-release.sh <tag> [--skip-build] [--skip-install]
#
# Produces frame-<tag>.tar.gz and frame-<tag>.tar.gz.sha256 in release-out/
# (override with FRAME_RELEASE_OUT). The tarball's top level contains dist/,
# package.json, package-lock.json, production node_modules/ and VERSION, which
# is the layout pi/updater/frame-update.sh expects.
#
# --skip-build / --skip-install exist for the offline test only.
# FRAME_PROJECT_DIR overrides the project root (default: parent of scripts/).
set -euo pipefail

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

# Validate the tag before doing anything else.
if [[ $# -lt 1 ]] || ! [[ "$1" =~ $TAG_RE ]]; then
  echo "usage: make-release.sh vX.Y.Z [--skip-build] [--skip-install]" >&2
  exit 2
fi
TAG="$1"
shift

SKIP_BUILD=0
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    *) echo "make-release.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${FRAME_PROJECT_DIR:-$HERE/..}"
PROJECT="$(cd "$PROJECT" && pwd)"
OUT_DIR="${FRAME_RELEASE_OUT:-$PROJECT/release-out}"

NAME="frame-$TAG.tar.gz"

# Keep macOS tar from adding AppleDouble (._*) entries.
export COPYFILE_DISABLE=1

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  (cd "$PROJECT" && npm run build)
fi
if [[ ! -f "$PROJECT/dist/server/index.js" ]]; then
  echo "make-release.sh: $PROJECT/dist/server/index.js missing (build first)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir "$STAGE/pkg"
cp -R "$PROJECT/dist" "$STAGE/pkg/dist"
cp "$PROJECT/package.json" "$PROJECT/package-lock.json" "$STAGE/pkg/"
printf '%s\n' "$TAG" > "$STAGE/pkg/VERSION"

ENTRIES=(dist package.json package-lock.json VERSION)
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  # Must run on arm64 Linux so native modules (sharp) match the Pi.
  (cd "$STAGE/pkg" && npm ci --omit=dev --no-audit --no-fund)
  ENTRIES+=(node_modules)
fi

# Explicit top-level names: no ./ prefix, no wrapping directory.
tar -C "$STAGE/pkg" -czf "$STAGE/$NAME" "${ENTRIES[@]}"
printf '%s  %s\n' "$(sha256_of "$STAGE/$NAME")" "$NAME" > "$STAGE/$NAME.sha256"

mkdir -p "$OUT_DIR"
mv -f "$STAGE/$NAME" "$OUT_DIR/$NAME"
mv -f "$STAGE/$NAME.sha256" "$OUT_DIR/$NAME.sha256"
echo "wrote $OUT_DIR/$NAME"
echo "wrote $OUT_DIR/$NAME.sha256"
