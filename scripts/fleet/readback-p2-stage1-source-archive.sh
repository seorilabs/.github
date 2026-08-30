#!/usr/bin/env bash

set -euo pipefail
archive=""
expected_sha=""
for argument in "$@"; do
  case "$argument" in
    --archive=*) archive="${argument#--archive=}" ;;
    --sha=*) expected_sha="${argument#--sha=}" ;;
    *) exit 126 ;;
  esac
done
if [[ ! "$archive" =~ ^/var/tmp/seorilabs-fleet-p2/[a-f0-9]{40}-[a-f0-9]{64}\.tar$ ]] || \
   [[ ! "$expected_sha" =~ ^[a-f0-9]{64}$ ]]; then
  exit 126
fi
if [[ -L "$archive" ]]; then
  printf '{"state":"DRIFT"}\n'
  exit 0
fi
if [[ ! -e "$archive" ]]; then
  printf '{"state":"ABSENT"}\n'
  exit 0
fi
if [[ ! -f "$archive" ]]; then
  printf '{"state":"DRIFT"}\n'
  exit 0
fi
before="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' "$archive")"
exec 8<"$archive"
held="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' /proc/self/fd/8)"
actual="$(/usr/bin/sha256sum /proc/self/fd/8 | /usr/bin/awk '{print $1}')"
after="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' "$archive")"
if [[ "$before" != "$held" ]] || [[ "$before" != "$after" ]] || [[ "$actual" != "$expected_sha" ]]; then
  printf '{"state":"DRIFT"}\n'
else
  printf '{"state":"EXACT_READBACK"}\n'
fi
