#!/usr/bin/env bash
set -euo pipefail
test "${SEORI_BUILD_MODE:-}" = build-only
test -n "${SEORI_AIT_OUTPUT:-}"
printf 'fixture-ait' > "$SEORI_AIT_OUTPUT"
