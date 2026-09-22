#!/bin/sh
set -eu
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../integrations/hermes/skills/flourish" && pwd)"
TARGET_ROOT="${FLOURISH_HERMES_SKILLS_DIR:-/root/.hermes/skills}"
TARGET_DIR="$TARGET_ROOT/flourish"

mkdir -p "$TARGET_ROOT"
STAGING_DIR="$(mktemp -d "$TARGET_ROOT/.flourish-install.XXXXXX")"
PREVIOUS_DIR="$TARGET_ROOT/.flourish-previous.$$"

cleanup() {
  rm -rf "$STAGING_DIR" "$PREVIOUS_DIR"
}
trap cleanup EXIT HUP INT TERM

cp -R "$SOURCE_DIR/." "$STAGING_DIR/"
chmod +x "$STAGING_DIR/scripts/flourish_api.py"
python3 "$STAGING_DIR/scripts/flourish_api.py" health

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$PREVIOUS_DIR"
fi

if ! mv "$STAGING_DIR" "$TARGET_DIR"; then
  if [ -e "$PREVIOUS_DIR" ]; then
    mv "$PREVIOUS_DIR" "$TARGET_DIR"
  fi
  exit 1
fi

rm -rf "$PREVIOUS_DIR"
echo "Installed Flourish Hermes skill at $TARGET_DIR"
