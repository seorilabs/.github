#!/usr/bin/env bash
set -euo pipefail
test "${SEORI_BUILD_MODE:-}" = build-only
test -n "${SEORI_AIT_OUTPUT:-}"
pnpm --dir apps/ait build
printf 'fixture-ait' > "$SEORI_AIT_OUTPUT"
