#!/usr/bin/env bash

set -euo pipefail
umask 077

host_name=""
source_sha=""
archive_path=""
archive_sha=""
lock_sha=""
contract_digest=""
confirmation=""

for argument in "$@"; do
  case "$argument" in
    --host=*) host_name="${argument#--host=}" ;;
    --source-sha=*) source_sha="${argument#--source-sha=}" ;;
    --archive=*) archive_path="${argument#--archive=}" ;;
    --archive-sha=*) archive_sha="${argument#--archive-sha=}" ;;
    --lock-sha=*) lock_sha="${argument#--lock-sha=}" ;;
    --contract-digest=*) contract_digest="${argument#--contract-digest=}" ;;
    --confirmation=*) confirmation="${argument#--confirmation=}" ;;
    *) exit 126 ;;
  esac
done

sha40='^[a-f0-9]{40}$'
sha256='^[a-f0-9]{64}$'
if [[ ! "$source_sha" =~ $sha40 ]] || [[ ! "$archive_sha" =~ $sha256 ]] || \
   [[ ! "$lock_sha" =~ $sha256 ]] || [[ ! "$contract_digest" =~ $sha256 ]] || \
   [[ "$archive_path" != "/var/tmp/seorilabs-fleet-p2/${source_sha}-${archive_sha}.tar" ]]; then
  exit 126
fi

case "$host_name" in
  rpi5)
    expected_hostname="rpi5"; expected_ip="192.168.0.99"; expected_machine="aarch64"; node_arch="arm64" ;;
  rpi4001)
    expected_hostname="rpi4001"; expected_ip="192.168.0.100"; expected_machine="aarch64"; node_arch="arm64" ;;
  seori-m6-01)
    expected_hostname="seori-m6-01"; expected_ip="192.168.0.118"; expected_machine="x86_64"; node_arch="x64" ;;
  *) exit 126 ;;
esac

expected_confirmation="fleet-p2-stage1-bootstrap-source-${host_name}-${source_sha:0:12}-${archive_sha:0:12}-${contract_digest:0:16}"
if [[ "$confirmation" != "$expected_confirmation" ]]; then
  exit 126
fi

required_executables=(
  /bin/bash /bin/cat /bin/sh /usr/bin/awk /usr/bin/cc /usr/bin/chmod /usr/bin/chown
  /usr/bin/cut /usr/bin/dd /usr/bin/find /usr/bin/grep /usr/bin/hostname /usr/bin/install
  /usr/bin/ln /usr/bin/mkdir /usr/bin/mv /usr/bin/readlink /usr/bin/rm /usr/bin/tar
  /usr/bin/sha256sum /usr/bin/stat /usr/bin/sync /usr/bin/uname /usr/sbin/ip
  /usr/local/bin/node /usr/local/bin/npm
)
for executable in "${required_executables[@]}"; do
  if [[ ! -x "$executable" ]]; then exit 126; fi
done

if [[ "$(/usr/bin/hostname --short)" != "$expected_hostname" ]] || \
   [[ "$(/usr/bin/uname --machine)" != "$expected_machine" ]] || \
   ! /usr/sbin/ip -4 -o address show scope global | /usr/bin/awk '{print $4}' | \
      /usr/bin/cut -d/ -f1 | /usr/bin/grep -Fxq "$expected_ip"; then
  exit 126
fi

initial_namespace="$(/usr/bin/stat -Lc '%d:%i' /proc/1/ns/mnt)"
self_namespace="$(/usr/bin/stat -Lc '%d:%i' /proc/self/ns/mnt)"
initial_type="$(/usr/bin/stat -f -c '%t' /proc/1/ns/mnt)"
self_type="$(/usr/bin/stat -f -c '%t' /proc/self/ns/mnt)"
if [[ "$initial_namespace" != "$self_namespace" ]] || [[ "$initial_type" != "6e736673" ]] || \
   [[ "$self_type" != "6e736673" ]]; then
  exit 126
fi

node_root="/opt/seorilabs/node-v24.16.0-linux-${node_arch}"
for command in node npm npx corepack; do
  link="/usr/local/bin/${command}"
  target="${node_root}/bin/${command}"
  if [[ ! -L "$link" ]] || [[ "$(/usr/bin/readlink "$link")" != "$target" ]]; then
    exit 126
  fi
done
if [[ "$(/usr/local/bin/node --version)" != "v24.16.0" ]] || \
   [[ "$(/usr/local/bin/npm --version)" != "11.13.0" ]]; then
  exit 126
fi

install_root="/opt/seorilabs/fleet-p2"
target="${install_root}/${source_sha}"
receipt="${target}/stage1-source.json"
native_helper="${target}/tools/seori-auth/.build/seori-auth-native"
native_launcher="/usr/local/libexec/seori-auth-native"
process_boundary="/usr/local/libexec/seorilabs-p2-process-hardening.node"
record_boundary="/usr/local/libexec/seorilabs-p2-host-fs-boundary"

readback() {
  if [[ ! -d "$target" ]] || [[ -L "$target" ]] || [[ ! -f "$receipt" ]] || \
     [[ -L "$receipt" ]] || [[ ! -x "$native_helper" ]] || [[ -L "$native_helper" ]] || \
     [[ ! -x "$native_launcher" ]] || [[ -L "$native_launcher" ]] || \
     [[ ! -x "$process_boundary" ]] || [[ -L "$process_boundary" ]] || \
     [[ ! -x "$record_boundary" ]] || [[ -L "$record_boundary" ]]; then
    return 1
  fi
  receipt_mode="$(/usr/bin/stat -Lc '%a' "$receipt")"
  if [[ "$receipt_mode" != "444" ]]; then return 1; fi
  if /usr/bin/find "$target" \( -type l -o ! -user root -o -perm /0022 \) -print -quit | \
     /usr/bin/grep -q .; then
    return 1
  fi
  /usr/local/bin/node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    const [receiptPath, sourceSha, archiveSha, lockSha, sourceNativePath, nativePath,
      processPath, recordPath] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const digest = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    if (value.schemaVersion !== 1 || value.state !== "P2_STAGE1_SOURCE_READY" ||
        value.sourceSha !== sourceSha || value.archiveSha256 !== archiveSha ||
        value.packageLockSha256 !== lockSha || value.sourceNativeHelperPath !== sourceNativePath ||
        value.packageLockSha256 !== digest(path.join(path.dirname(receiptPath), "package-lock.json")) ||
        value.sourceNativeHelperSha256 !== digest(sourceNativePath) ||
        value.nativeLauncherPath !== nativePath || value.nativeLauncherSha256 !== digest(nativePath) ||
        value.processBoundaryPath !== processPath || value.processBoundarySha256 !== digest(processPath) ||
        value.recordBoundaryPath !== recordPath ||
        value.recordBoundarySha256 !== digest(recordPath) || value.nodeVersion !== "24.16.0" ||
        value.npmVersion !== "11.13.0") process.exit(126);
  ' "$receipt" "$source_sha" "$archive_sha" "$lock_sha" "$native_helper" "$native_launcher" \
    "$process_boundary" "$record_boundary"
}

verify_process_boundary() {
  "$native_launcher" launch -- /usr/local/bin/node -e '
    const receipt = require(process.argv[1]);
    const expected = process.platform === "linux"
      ? {state:"PROCESS_HARDENING_OK",coreSoft:0,coreHard:0,dumpable:0,noNewPrivileges:1}
      : {state:"PROCESS_HARDENING_OK",coreSoft:0,coreHard:0,denyAttachApplied:true};
    if (Object.keys(receipt).sort().join("\0") !== Object.keys(expected).sort().join("\0") ||
        Object.entries(expected).some(([key,value]) => receipt[key] !== value)) process.exit(126);
  ' "$process_boundary"
}

if [[ -e "$target" ]] || [[ -L "$target" ]]; then
  readback || exit 126
  verify_process_boundary || exit 126
  /usr/local/bin/node -e '
    const [nodeName, sourceSha, archiveSha256, packageLockSha256] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({schemaVersion:1,state:"P2_STAGE1_SOURCE_READY",nodeName,
      sourceSha,archiveSha256,packageLockSha256,installState:"EXACT_READBACK",secretExposed:false})+"\n");
  ' "$host_name" "$source_sha" "$archive_sha" "$lock_sha"
  exit 0
fi

if [[ -L "$archive_path" ]] || [[ ! -f "$archive_path" ]]; then exit 126; fi
archive_identity="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' "$archive_path")"
exec 8<"$archive_path"
held_identity="$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s' /proc/self/fd/8)"
if [[ "$archive_identity" != "$held_identity" ]] || \
   [[ "$(/usr/bin/sha256sum /proc/self/fd/8 | /usr/bin/awk '{print $1}')" != "$archive_sha" ]]; then
  exit 126
fi

/usr/bin/install -d -o root -g root -m 0755 /opt/seorilabs "$install_root"
if /usr/bin/find "$install_root" -mindepth 1 -maxdepth 1 -name ".${source_sha}.staging.*" -print -quit | \
   /usr/bin/grep -q .; then
  exit 126
fi
staging="${install_root}/.${source_sha}.staging.$$"
/usr/bin/mkdir -m 0700 "$staging"
created_staging=true
cleanup() {
  if [[ "${created_staging:-false}" == true ]] && [[ -d "$staging" ]] && [[ ! -L "$staging" ]]; then
    /usr/bin/rm -rf --one-file-system -- "$staging"
  fi
}
trap cleanup EXIT INT TERM

/usr/bin/tar --extract --file=/proc/self/fd/8 --directory="$staging" --no-same-owner --no-same-permissions
if /usr/bin/find "$staging" -type l -print -quit | /usr/bin/grep -q .; then exit 126; fi
if [[ "$(/usr/bin/sha256sum "$staging/package-lock.json" | /usr/bin/awk '{print $1}')" != "$lock_sha" ]]; then
  exit 126
fi

(cd "$staging" && /usr/local/bin/npm ci --ignore-scripts --no-bin-links --workspaces=false \
  --audit=false --fund=false)
/usr/local/bin/node "$staging/tools/seori-auth/scripts/build-native.mjs" \
  "$staging/tools/seori-auth/.build/seori-auth-native"
/usr/local/bin/node "$staging/scripts/fleet/build-p2-process-hardening-boundary.mjs" \
  "$staging/.build/seorilabs-p2-process-hardening.node"
/usr/local/bin/node "$staging/scripts/fleet/build-p2-host-fs-boundary.mjs" \
  "$staging/.build/seorilabs-p2-host-fs-boundary"

staging_native="$staging/tools/seori-auth/.build/seori-auth-native"
staging_process="$staging/.build/seorilabs-p2-process-hardening.node"
staging_record="$staging/.build/seorilabs-p2-host-fs-boundary"
native_sha="$(/usr/bin/sha256sum "$staging_native" | /usr/bin/awk '{print $1}')"
process_sha="$(/usr/bin/sha256sum "$staging_process" | /usr/bin/awk '{print $1}')"
record_sha="$(/usr/bin/sha256sum "$staging_record" | /usr/bin/awk '{print $1}')"
/usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec
install_exact_helper() {
  local source="$1"
  local destination="$2"
  local expected_sha="$3"
  if [[ -e "$destination" ]] || [[ -L "$destination" ]]; then
    if [[ -L "$destination" ]] || [[ ! -f "$destination" ]] || \
       [[ "$(/usr/bin/stat -Lc '%u:%g:%a' "$destination")" != "0:0:755" ]] || \
       [[ "$(/usr/bin/sha256sum "$destination" | /usr/bin/awk '{print $1}')" != "$expected_sha" ]]; then
      exit 126
    fi
  else
    /usr/bin/ln "$source" "$destination"
    /usr/bin/sync -f /usr/local/libexec
  fi
}
install_exact_helper "$staging_native" "$native_launcher" "$native_sha"
install_exact_helper "$staging_process" "$process_boundary" "$process_sha"
install_exact_helper "$staging_record" "$record_boundary" "$record_sha"
/usr/local/bin/node -e '
  const fs = require("node:fs");
  const [path,nodeName,sourceSha,archiveSha256,packageLockSha256,nativeHelperPath,nativeHelperSha256,
    nativeLauncherPath,processBoundaryPath,processBoundarySha256,recordBoundaryPath,
    recordBoundarySha256] = process.argv.slice(1);
  const value={schemaVersion:1,state:"P2_STAGE1_SOURCE_READY",nodeName,sourceSha,archiveSha256,
    packageLockSha256,nodeVersion:"24.16.0",npmVersion:"11.13.0",
    sourceNativeHelperPath:nativeHelperPath,sourceNativeHelperSha256:nativeHelperSha256,
    nativeLauncherPath,nativeLauncherSha256:nativeHelperSha256,processBoundaryPath,
    processBoundarySha256,recordBoundaryPath,recordBoundarySha256,
    dependencyPolicy:"NPM_CI_LOCKFILE_IGNORE_SCRIPTS"};
  fs.writeFileSync(path, JSON.stringify(value)+"\n", {flag:"wx",mode:0o444});
' "$staging/stage1-source.json" "$host_name" "$source_sha" "$archive_sha" "$lock_sha" \
  "$native_helper" "$native_sha" "$native_launcher" "$process_boundary" "$process_sha" \
  "$record_boundary" "$record_sha"
/usr/bin/chmod 0444 "$staging/stage1-source.json"
/usr/bin/chown -R root:root "$staging"
/usr/bin/find "$staging" -type d -exec /usr/bin/chmod go-w {} +
/usr/bin/find "$staging" -type f -exec /usr/bin/chmod go-w {} +

/usr/bin/mv --no-clobber -T "$staging" "$target"
created_staging=false
readback || exit 126
verify_process_boundary || exit 126
/usr/bin/sync -f "$install_root"
/usr/local/bin/node -e '
  const [nodeName, sourceSha, archiveSha256, packageLockSha256] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({schemaVersion:1,state:"P2_STAGE1_SOURCE_READY",nodeName,
    sourceSha,archiveSha256,packageLockSha256,installState:"CREATED",secretExposed:false})+"\n");
' "$host_name" "$source_sha" "$archive_sha" "$lock_sha"
