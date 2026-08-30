# Fleet P2 RPI5 host encryption provisioning

## 현재 상태

이 문서는 `contracts/fleet-p2-host-encryption.yaml`의 코드 계약과 실행 순서를 설명한다.
저장소 반영만으로 RPI5, Tang 서버, Kubernetes 또는 credential catalog가 변경되지는 않는다.
계약 상태는 `blocked_unverified`이며 아래 live readback과 reboot 검증이 모두 끝날 때까지 Auth
Broker workload를 활성화하지 않는다.

고정 대상은 다음과 같다.

- RPI5: `rpi5` / `192.168.0.99`
- Tang 1: `rpi4001` / `192.168.0.100:7500`
- Tang 2: `seori-m6-01` / `192.168.0.118:7500`
- encrypted image: `/data/seori-auth/seori-auth-state.luks`, 16 GiB non-sparse
- mapper: `/dev/mapper/seori-auth-state`
- filesystem/mount: `ext4`, `/var/lib/seori-auth`

`seori-m6-01`은 `192.168.0.118`에서 `hostname --short`로 readback한 exact identity다.
연결용 별칭과 실제 hostname을 혼용하지 않는다.

## 보안 경계

- 모든 명령의 기본값은 `plan`이며 mutation에는 contract digest 기반 exact confirmation이 필요하다.
- `plan`을 제외한 host 명령은 Node caller와 native boundary 모두에서 현재 mount namespace가
  `/proc/1/ns/mnt`의 initial host namespace와 같은 nsfs device/inode인지 확인한다. `unshare`, container
  또는 다른 mount namespace에서는 hostname/IP가 같아도 readback과 mutation을 시작하지 않는다.
  native boundary는 PID 1 root identity, exact `systemd` comm과 non-container cgroup도 함께 확인하므로
  container 자체 PID 1을 host PID 1로 오인하지 않는다.
- `plan` 이외의 host와 Tang 명령은 `/usr/local/libexec/seori-auth-native launch --`로만 시작한다.
  Linux `execve`가 dumpable을 다시 설정하므로 child는 고정 N-API boundary를 민감 접근 전에 로드한다.
  boundary는 launcher에서 상속된 `RLIMIT_CORE` soft/hard 0과 `PR_GET_NO_NEW_PRIVS=1`을 확인하고,
  `PR_SET_DUMPABLE=0`을 재적용한 뒤 `PR_GET_DUMPABLE=0`을 직접 readback한다. launcher marker만
  위조하거나 plain `node`로 실행하면 host path와 JWK/recovery key를 읽기 전에 중단한다.
- 같은 N-API boundary는 Stage1 macOS controller에서도 재사용한다. local launcher는 getpwuid로
  정한 home 아래 `~/.config/seorilabs/bin`의 current-user `0500` launcher와 `0400` module만 허용한다.
  실행 source는 credential backup 대상 밖인
  `~/.local/share/seorilabs/fleet-p2/<exact-source-sha>`의 create-only archive와 receipt로 고정하며,
  dirty primary checkout이나 임의 worktree controller는 거부한다. launcher는 module, exact runtime
  controller, source receipt를 각각 FD 5, 6, 7에 inode와 SHA-256까지 결합한다. child는 receipt의 source,
  archive, lockfile, contract, controller와 runtime manifest binding을 다시 확인하고 FD를 소비·폐기한
  뒤에만 민감 데이터를 읽을 수 있다. 기존 `~/.local`과 `~/.local/share`는 owner와 non-writable
  ancestor 조건만 확인하고 mode를 바꾸지 않으며, 관리 경계인 `share/seorilabs`부터 exact `0700`이다.
  Darwin child는 상속된
  `RLIMIT_CORE` soft/hard 0을 확인하고 `PT_DENY_ATTACH`를 다시 호출한다. Darwin에는
  `P_LNOATTACH`의 public getter가 없으므로 marker를 readback으로 간주하지 않으며, 성공한 syscall을
  [Apple `ptrace` contract](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/ptrace.2.html)에
  따른 kernel 적용 acknowledgement로만 기록한다. syscall 실패 시 module initialization이 예외로 끝나
  Ed25519/X25519 private material이나 복호화 JWK를 JavaScript가 읽기 전에 중단한다.
- recovery key는 canonical root-owned `0400` 또는 `0600` regular file path로만 받는다. 도구는 내용을
  읽거나 생성하지 않고 `O_NOFOLLOW`로 한 번 연 FD와 최초 `fstat` identity를 고정한다. 모든
  secret-consuming child에는 같은 FD 3만 전달하며 중간에 파일 path를 다시 열지 않는다. 값과 원본
  경로는 child argv, 환경, stdout, stderr, marker, receipt에 남지 않는다.
- source, rollback destination, mount와 backup parent는 `lstat + realpath + device + inode`로 backup
  receipt에 고정한다. symlink와 broken symlink는 거부한다. source 생성, header backup, source
  rollback/restore와 system config 교환은 고정 경로만 허용하는 root-owned native boundary가 directory
  FD를 연 채 `openat O_EXCL` 또는 `renameat2 RENAME_NOREPLACE/RENAME_EXCHANGE`로 실행한다. caller의
  사전 existence 확인은 mutation 안전성을 대신하지 않는다.
- pre-backup, managed config, marker, provision/reboot/rollback receipt도 path를 argv로 받지 않는다.
  caller는 allowlist record ID와 bytes를 stdin으로만 넘기고 native boundary가 host-root부터 component별
  `openat O_NOFOLLOW`로 연 parent dirfd 안에서 고정 pending entry의 identity-bound crash recovery,
  `openat O_EXCL`, `renameat2 RENAME_NOREPLACE`, file·directory `fsync`와 inode readback을 수행한다.
  marker의 `root:65532 0440` metadata도 같은 FD 경계에서 고정한다.
- apply 전에는 source와 mapper가 없어야 하고 mount target은 비어 있어야 한다. source만 생긴 상태,
  mapper만 열린 상태, systemd line 일부만 있는 상태는 자동 복구하지 않고 `READBACK_FIRST`로
  중단한다.
- 기존 `crypttab`/`fstab`은 고정 backup root에 먼저 복제하고 byte-for-byte restore rehearsal을
  통과해야 한다. rollback/restore에서는 원본과 managed bytes를 FD로 native boundary에 넘기고,
  `/etc` dirfd 안의 고정 swap entry와 원자 교환한 뒤 content와 metadata를 다시 읽는다. LUKS format
  뒤에는 source FD와 backup dirfd에 결합된 header backup과 recovery-key `--test-passphrase`
  rehearsal을 모두 통과한다.
- marker는 exact `cryptsetup luksUUID`, non-sparse allocation, Clevis policy, `findmnt --mountpoint`의
  mapper/ext4 identity, `cryptsetup status`와 `dmsetup`의 mapper UUID, `losetup`의 exact loop backing
  source identity, systemd persistence, PV/PVC UID와 resourceVersion을 읽은 다음에만 canonical
  `buildHostEncryptedMountAttestation`으로 생성한다. owner/group/mode는 `root:65532 0440`이다.
- plain root filesystem fallback에는 marker를 만들지 않는다. mount drift가 있으면 marker가 이미
  있어도 실패한다.
- `fstab` persistence는 mapper 이름을 systemd 방식으로 escape한
  `systemd-cryptsetup@seori\x2dauth\x2dstate.service`를 exact 요구한다. raw mapper 이름을 unit에
  넣은 line은 contract drift다.
- 모든 host backup/apply/readback/rollback/restore는 먼저 알려진 workload replica가 0인지, 활성
  Pod가 해당 PVC를 소비하지 않는지 확인한다. hostPath는 mount/source/mapper 보호 경로의 descendant뿐
  아니라 `/var/lib`, `/data`, `/dev/mapper` 같은 ancestor와 exact path도 양방향 overlap으로 차단한다.
- mutation child가 오류 또는 timeout을 반환하면 성공/실패를 추측하거나 명령을 반복하지 않는다.
  `*_MUTATION_OUTCOME_UNKNOWN`으로 멈춘 뒤 readback부터 다시 시작한다.

Clevis는 공식 SSS 정책의 threshold `t: 1`과 두 Tang pin을 사용한다. 따라서 두 서버 중 하나가
응답하면 unlock할 수 있지만, binding 시점에는 두 서버의 exact signing thumbprint와 advertisement
SHA-256이 모두 필요하다. Clevis의 1-of-2 구성은
[upstream Clevis README](https://github.com/latchset/clevis#pin-shamir-secret-sharing), signing
thumbprint의 사전 검증은
[clevis-encrypt-tang](https://github.com/latchset/clevis/blob/master/src/pins/tang/clevis-encrypt-tang.1.adoc),
non-root volume의 `_netdev` boot unlock은
[Red Hat NBDE guide](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/security_guide/sec-policy-based_decryption)를 따른다.

## Tang 서버 순서

각 서버에서 먼저 plan을 확인한다.

```bash
node scripts/fleet/provision-p2-tang-server.mjs plan --server=rpi4001
node scripts/fleet/provision-p2-tang-server.mjs plan --server=seori-m6-01
```

apply는 plan이 반환한 exact confirmation을 사용한다. Ubuntu/Debian exact identity, port collision,
package와 socket override를 먼저 읽고, 알려지지 않은 partial state에서는 아무것도 바꾸지 않는다.
`apply`와 `readback`도 PID 1 initial mount namespace와 production native boundary를 먼저 검증한다.
socket override는 Node의 absolute path writer가 아니라 고정 record ID와 stdin bytes만 native boundary에
전달하며, boundary가 `/etc/systemd/system` dirfd 아래 exact directory를 `mkdirat/openat O_NOFOLLOW`로
고정하고 `linkat` no-clobber, file·directory `fsync`, inode readback으로 게시한다. 동일 production
helper를 각 Tang 서버에도 먼저 설치한다. 새 서버는 이 drop-in을 게시한 다음에만 `apt-get install tang`,
`daemon-reload`, `enable --now`를 실행하므로 package post-install이 기본 socket을 먼저 시작하지 않는다.
drop-in 게시 후 package 설치 전 중단된 상태는 다음 `apply`가 exact bytes를 readback한 뒤 재개한다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-tang-server.mjs apply \
  --server=<exact-node-name> \
  --confirmation=<plan-returned-confirmation>
```

apply 결과는 `TANG_SERVER_KEYS_BACKUP_REQUIRED`다. trusted Tang adapter만 JWK를 `O_NOFOLLOW`로
열어 내용과 owner/group/mode의 비공개 fingerprint를 계산하며 raw JWK나 개별 fingerprint를 stdout,
로그, attestation으로 반환하지 않는다. 각 JWK는 package `tangd-keygen` 결과와 같은 exact `0440`이고
owner/group는 key directory와 같아야 한다. credential backup authority는 고정 logical credential로
canonical 암호화 backup과 격리 restore를 수행하고, 두 inventory fingerprint의 일치 증거를 고정
Ed25519 identity로 서명해야 한다. caller가 만든 digest나 self-hash만으로는
`TANG_SERVER_KEYS_BACKUP_RESTORE_VERIFIED`가 되지 않는다. 서명된 private evidence 파일은
root-owned `0400`/`0600`으로 서버 adapter에만 전달하고, 서버가 live inventory와 대조한 뒤 공개
envelope만 `TANG_SERVER_VERIFIED`에 포함한다. host는 고정
`/etc/seorilabs/trust/credential-backup-attestor.ed25519.pem` 신뢰 앵커로 다시 검증한다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-tang-server.mjs readback \
  --server=<exact-node-name> \
  --backup-attestation=/canonical/root-owned/path/to/signed-private-backup-evidence.json
```

`tang-show-keys`의 signing thumbprint는 server-local 결과와 client가 받은 advertisement를 비교하는
공식 경계다. [tang-show-keys manual](https://github.com/latchset/tang/blob/master/doc/tang-show-keys.1.adoc)

## RPI5 순서

두 `TANG_SERVER_VERIFIED` attestation과 canonical kubeconfig를 준비한 뒤 plan을 확인한다.
먼저 RPI5 또는 검증된 Linux ARM64 환경에서 native boundary를 빌드하고 별도 승인된 root 설치 단계에서
plan의 exact executable path에
root-owned, group/world non-writable file로 설치한다. production entrypoint는 `SEORILABS_KUBECTL`
override를 거부하고 canonical `/usr/local/bin/kubectl`만 사용한다.
`tools/seori-auth/.build/seori-auth-native`도 같은 Linux ARM64 source에서 빌드해
`/usr/local/libexec/seori-auth-native`에 root-owned `0755`로 설치한다. 또한
`scripts/fleet/build-p2-process-hardening-boundary.mjs`가 만든 N-API artifact를
`/usr/local/libexec/seorilabs-p2-process-hardening.node`에 root-owned `0755`로 설치한다.

host filesystem production helper는 macOS에서 빌드되지 않는다. process-hardening N-API artifact는
Linux와 macOS 각각에서 해당 architecture용으로 빌드하며 서로 교환하지 않는다. Stage1 macOS
controller는 root `/usr/local/libexec` 설치나 사용자 primary checkout을 사용하지 않는다. current-user
create-only `~/.config/seorilabs/bin` boundary와 credential backup에서 분리된 exact-SHA runtime을 사용한다.
중앙 `Contract Checks`와 `WorkflowBundle Candidate`는 Node `24.16.0`의
GitHub-hosted Linux ARM64 runner에서 production ELF를 실제 실행하고, 격리된
`/root/seorilabs-p2-native-harness-*` root에서 record publish/no-clobber, source rename/restore와 alternate
mount namespace 거부 syscall harness를 통과해야 한다. 별도 macOS ARM64 job은 native launcher로
N-API module을 실제 load하고 plain Node, source/receipt digest drift, dirty primary controller를 거부하며
FD 5/6/7과 `PT_DENY_ATTACH` 적용 receipt를 실제 검증한다.

```bash
node scripts/fleet/build-p2-host-fs-boundary.mjs
sudo install -o root -g root -m 0755 \
  .build/seorilabs-p2-host-fs-boundary \
  /usr/local/libexec/seorilabs-p2-host-fs-boundary
```

```bash
node scripts/fleet/provision-p2-host-encryption.mjs plan
```

먼저 empty-state와 Kubernetes PV/PVC identity를 읽고 system configuration backup을 만든다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs backup \
  --confirmation=<plan-returned-backup-confirmation> \
  --kubeconfig=/canonical/path/to/kubeconfig
```

그 다음 apply한다. recovery key 값은 prompt, argv, 환경변수로 전달하지 않는다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs apply \
  --confirmation=<plan-returned-apply-confirmation> \
  --kubeconfig=/canonical/path/to/kubeconfig \
  --recovery-key-file=/canonical/root-owned/path \
  --tang-attestation=/canonical/path/to/rpi4001.json \
  --tang-attestation=/canonical/path/to/seori-m6-01.json
```

apply 성공은 reboot persistence 완료가 아니다. 먼저 readback한 뒤 RPI5를 승인된 별도 작업으로
재부팅하고, boot ID가 실제로 달라진 상태에서 `reboot-readback`을 실행한다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs readback \
  --kubeconfig=/canonical/path/to/kubeconfig \
  --tang-attestation=/canonical/path/to/rpi4001.json \
  --tang-attestation=/canonical/path/to/seori-m6-01.json

sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs reboot-readback \
  --kubeconfig=/canonical/path/to/kubeconfig \
  --tang-attestation=/canonical/path/to/rpi4001.json \
  --tang-attestation=/canonical/path/to/seori-m6-01.json
```

최종 상태 `HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED` 전에는 workload replicas를 올리지 않는다. 반대로
host state를 변경하려면 먼저 replicas와 PVC/hostPath consumer를 0으로 내려야 한다.

## rollback과 restore

rollback은 reboot-verified receipt, unchanged system configuration, header backup digest와 recovery-key
rehearsal을 모두 요구한다. LUKS image는 삭제하지 않고 고정 rollback path로 같은 filesystem 안에서
native dirfd 경계의 `renameat2 RENAME_NOREPLACE`로 atomic rename한다. 교차 filesystem이면 복사 후
삭제로 대체하지 않고 중단한다. mount를 닫은 후
plain fallback directory에 marker가 없는 것도 다시 확인한다. marker는 encrypted ext4 내부에 그대로
보존되며 rollback receipt는 그 digest를 고정한다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs rollback \
  --confirmation=<plan-returned-rollback-confirmation> \
  --kubeconfig=/canonical/path/to/kubeconfig \
  --recovery-key-file=/canonical/root-owned/path \
  --tang-attestation=/canonical/path/to/rpi4001.json \
  --tang-attestation=/canonical/path/to/seori-m6-01.json
```

restore도 rollback receipt, header/recovery-key rehearsal, empty plain target, original configuration
digest와 metadata, 원래 `clevis-luks-askpass.path` enabled와 active 상태를 각각 확인한 뒤 image를
되돌린다. rollback도 enable/disable 및 start/stop을 각각 원래 값으로 복원하고 readback한다. mount
후에는 encrypted filesystem에 보존된 marker가 rollback receipt의 exact digest인지 재검증하며 새로
쓰지 않는다. 기존 provision receipt도 덮어쓰지 않고 `provision.restored.json`을 append-only로 만든다.
restore 뒤에는 새 reboot readback이 다시 필요하다.

```bash
sudo /usr/local/libexec/seori-auth-native launch -- \
  <absolute-node-path> scripts/fleet/provision-p2-host-encryption.mjs restore \
  --confirmation=<plan-returned-restore-confirmation> \
  --kubeconfig=/canonical/path/to/kubeconfig \
  --recovery-key-file=/canonical/root-owned/path \
  --tang-attestation=/canonical/path/to/rpi4001.json \
  --tang-attestation=/canonical/path/to/seori-m6-01.json
```

`cryptsetup luksFormat`, header backup과 restore의 파괴성은
[cryptsetup manual](https://man7.org/linux/man-pages/man8/cryptsetup.8.html)에 따라 별도 gate로
취급한다. source가 이미 존재하거나 state가 비어 있지 않으면 apply를 재실행하지 않는다.

테스트 fixture runtime은 `tests/fixtures/p2-*-fixture-entrypoint.mjs`에서만 주입할 수 있다. production
entrypoint에 fixture 환경변수를 넣으면 명령 실행 전에 `*_FIXTURE_INJECTION_FORBIDDEN`으로 중단한다.
