#!/usr/bin/env bash

set -euo pipefail

payload=""
expected_sha=""
for argument in "$@"; do
  case "$argument" in
    --payload=*) payload="${argument#--payload=}" ;;
    --sha=*) expected_sha="${argument#--sha=}" ;;
    *) exit 126 ;;
  esac
done

if [[ ! "$payload" =~ ^/var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\.payload$ ]] || \
   [[ ! "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || \
   [[ "$payload" != "/var/tmp/seorilabs-fleet-p2/relay-input-${expected_sha}.payload" ]]; then
  exit 126
fi

if [[ -L "$payload" ]]; then
  printf '{"state":"DRIFT"}\n'
  exit 0
fi
if [[ ! -e "$payload" ]]; then
  printf '{"state":"ABSENT"}\n'
  exit 0
fi
if [[ ! -f "$payload" ]]; then
  printf '{"state":"DRIFT"}\n'
  exit 0
fi

before="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' "$payload")"
exec 8<"$payload"
held="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' /proc/self/fd/8)"
actual="$(/usr/bin/sha256sum /proc/self/fd/8 | /usr/bin/awk '{print $1}')"
after="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' "$payload")"
if [[ "$before" != "$held" ]] || [[ "$before" != "$after" ]] || \
   [[ "$actual" != "$expected_sha" ]] || \
   [[ "$before" != *":$(/usr/bin/id -u):$(/usr/bin/id -g):600:"* ]]; then
  printf '{"state":"DRIFT"}\n'
else
  printf '{"state":"EXACT_READBACK"}\n'
fi
