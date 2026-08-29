#!/usr/bin/env bash
set -euo pipefail
grep -Fq 'renderer/rendering_method="gl_compatibility"' project.godot
