#!/usr/bin/env bash

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for the approved macOS Secret Manager writer host." >&2
  exit 1
fi

if [ "$#" -ne 0 ]; then
  echo "Usage: install-p3-secret-manager-writer.sh" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$repo_root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Writer installation requires a clean checkout." >&2
  exit 1
fi
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "Writer installation requires a commit contained in origin/main." >&2
  exit 1
fi

node_path="$(command -v node)"
case "$node_path" in
  /*) ;;
  *) echo "Node executable path is not absolute." >&2; exit 1 ;;
esac

npm --prefix tools/seori-auth run build:native >/dev/null
helper_source="${repo_root}/tools/seori-auth/.build/seori-auth-native"
child_source="${repo_root}/tools/seori-auth/runtime/secret-manager-writer.mjs"
for source in "$node_path" "$helper_source" "$child_source"; do
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    echo "Trusted writer source is missing or symbolic." >&2
    exit 1
  fi
done

staging="$(mktemp -d "${TMPDIR:-/tmp}/seori-auth-writer-install.XXXXXX")"
cleanup() {
  rm -rf -- "$staging"
}
trap cleanup EXIT INT TERM

cp "$node_path" "${staging}/seori-auth-node"
cp "$helper_source" "${staging}/seori-auth-native"
cp "$child_source" "${staging}/secret-manager-writer.mjs"
chmod 555 "${staging}/seori-auth-node" "${staging}/seori-auth-native"
chmod 444 "${staging}/secret-manager-writer.mjs"

sudo -v
sudo install -d -o root -g wheel -m 755 /usr/local/libexec
sudo install -d -o root -g wheel -m 755 /opt/seori-auth /opt/seori-auth/runtime
sudo install -o root -g wheel -m 555 \
  "${staging}/seori-auth-node" /usr/local/libexec/seori-auth-node
sudo install -o root -g wheel -m 555 \
  "${staging}/seori-auth-native" /usr/local/libexec/seori-auth-native
sudo install -o root -g wheel -m 444 \
  "${staging}/secret-manager-writer.mjs" /opt/seori-auth/runtime/secret-manager-writer.mjs

for installed_path in \
  /usr/local/libexec/seori-auth-node \
  /usr/local/libexec/seori-auth-native \
  /opt/seori-auth/runtime/secret-manager-writer.mjs; do
  owner="$(stat -f '%Su:%Sg' "$installed_path")"
  mode="$(stat -f '%Sp' "$installed_path")"
  digest="$(shasum -a 256 "$installed_path" | awk '{print $1}')"
  printf '%s owner=%s mode=%s sha256=%s\n' "$installed_path" "$owner" "$mode" "$digest"
done
