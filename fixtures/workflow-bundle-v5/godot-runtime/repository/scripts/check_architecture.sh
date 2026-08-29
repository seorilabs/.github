#!/usr/bin/env bash
set -euo pipefail
grep -Fq 'config_version=5' project.godot
