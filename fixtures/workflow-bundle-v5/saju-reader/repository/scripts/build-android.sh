#!/usr/bin/env bash
set -euo pipefail
test "${SEORI_BUILD_MODE:-}" = build-only
test -n "${SEORI_ANDROID_AAB_OUTPUT:-}"
printf 'fixture-aab' > "$SEORI_ANDROID_AAB_OUTPUT"
