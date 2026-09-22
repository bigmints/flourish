#!/usr/bin/env bash

set -euo pipefail

archive=${1:?"usage: deploy-atomic.sh ARCHIVE RELEASE_ID BACKUP"}
release_id=${2:?"usage: deploy-atomic.sh ARCHIVE RELEASE_ID BACKUP"}
backup=${3:?"usage: deploy-atomic.sh ARCHIVE RELEASE_ID BACKUP"}

case "$archive" in
  /tmp/flourish-release-*.tgz) ;;
  *) echo "Release archive must be under /tmp and named flourish-release-*.tgz" >&2; exit 2 ;;
esac

case "$release_id" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid release ID" >&2; exit 2 ;;
esac

app_dir=/opt/flourish/app
releases_dir=/opt/flourish/releases
stage_dir="$releases_dir/stage-$release_id"
previous_dir="$releases_dir/previous-$release_id"
failed_dir="$releases_dir/failed-$release_id"

test -f "$archive"
test -f "$backup"
test ! -e "$stage_dir"
test ! -e "$previous_dir"
test ! -e "$failed_dir"

mkdir -p "$stage_dir"
tar -xzf "$archive" -C "$stage_dir"
test -f "$stage_dir/.next/standalone/server.js"
test ! -e "$stage_dir/.next/standalone/data"
test ! -e "$stage_dir/data"
mkdir -p "$stage_dir/.next/cache"
chown -R flourish:flourish "$stage_dir"

rollback() {
  systemctl stop flourish.service >/dev/null 2>&1 || true
  if test -d "$app_dir"; then
    mv "$app_dir" "$failed_dir"
  fi
  if test -d "$previous_dir"; then
    mv "$previous_dir" "$app_dir"
  fi
  systemctl start flourish.service
  curl -fsS --retry 20 --retry-delay 1 --retry-all-errors http://127.0.0.1:3210/api/v1/health >/dev/null
}

systemctl stop flourish.service
if ! mv "$app_dir" "$previous_dir"; then
  systemctl start flourish.service
  exit 1
fi

if ! mv "$stage_dir" "$app_dir"; then
  mv "$previous_dir" "$app_dir"
  systemctl start flourish.service
  exit 1
fi

if ! systemctl start flourish.service; then
  rollback
  exit 1
fi

if ! health=$(curl -fsS --retry 30 --retry-delay 1 --retry-all-errors http://127.0.0.1:3210/api/v1/health); then
  rollback
  exit 1
fi

printf '{"release":"%s","backup":"%s","health":%s}\n' "$release_id" "$backup" "$health"
