# Fleet P2 Stage 1 - Tang 설치와 서명 백업

## 현재 상태와 범위

`contracts/fleet-p2-stage1.yaml`은 세 호스트의 immutable source bootstrap, 두 Tang 서버의
create-only 설치, 별도 X25519 암호화 백업, 격리 복원 검증, Ed25519 attestation, RPI5 공개 trust
evidence 전달 순서를 고정한다. 코드와 fixture만 반영해도 호스트나 credential은 바뀌지 않는다.

2026-08-30 live readback 기준 세 호스트에는 공식 Node `24.16.0`과 npm `11.13.0`이 exact path로
설치되어 있고 C compiler를 포함한 prerequisite가 준비되어 있다. 반면 다음 상태는 아직 실행 전이다.

- 로컬 `~/.config/seorilabs/bin/seori-auth-native`와
  `~/.config/seorilabs/bin/seorilabs-p2-process-hardening.node`: 설치 전
- `shared/seori-auth/credential-backup-attestor`: 생성 전
- `shared/seori-auth/tang-backup-encryption`: 생성 전
- rpi4001, seori-m6-01 Tang package/key/service와 signed backup: 실행 전
- RPI5 LUKS image, mapper, mount와 reboot: 이 Stage 1 승인 범위 밖

credential 생성 전 백업 gate는 SHA-256
`fe37a8fc8f9c975c2583aec56635c0655e34f1b5df51c0686231566c9470826c`, 파일 8,880개,
격리 복원 성공으로 계약에 고정되어 있다. 이 값과 실제 backup evidence가 다르면 새 key를 만들지 않는다.
두 key pair를 create-only로 완성한 직후에는 pin된 canonical `backup-credentials.sh`가 local과
BeeStation 전체 백업을 새로 만들고 `restore-check.sh`가 격리 복원한다. archive/checksum/BeeStation
digest, file count, 두 logical ID와 public fingerprint를 Ed25519 서명한 post-bootstrap receipt가 없으면
source bootstrap, Tang provision과 backup은 모두 중단한다.

## 보안 경계

- Ed25519 attestor와 X25519 backup encryption key는 별도 logical credential이다. 전자는 서명만,
  후자는 Tang archive 암복호화만 수행한다. 기존 전역 credential backup passphrase를 호스트로 보내지
  않는다.
- 실제 JWK는 `_tang:_tang 0440`만 허용한다. `/var/lib/tang`을 held directory FD로 고정하고 child를
  `O_NOFOLLOW`로 연다. 호스트 root가 archive payload를 격리 경로에 실제 `fchown`/`fchmod`한 뒤
  `fstat` content와 owner, group, mode fingerprint를 live inventory와 비교한다. Mac의 local decrypt는
  ciphertext content를 별도로 검증하며 payload의 UID/GID를 실제 복원 metadata라고 주장하지 않는다.
- 로컬 secret-processing Node는 current-user canonical `seori-auth-native
  launch-local-controller`에서만 시작한다. launcher는 module, exact-SHA controller, source receipt를
  FD 5/6/7에 고정하고 digest와 inode를 검증한다. Node가 시작된 뒤 N-API boundary가 core limit과 native
  attach 방지를 재적용하고 readback하기 전에는 private key를 읽지 않는다. 호스트의 JWK 처리에는 별도
  root-owned launcher와 Linux hardening boundary를 사용한다.
- 로컬 source와 dependency는 credential backup에 섞지 않는다. exact git archive, lockfile 기반
  dependency, receipt는 `~/.local/share/seorilabs/fleet-p2/<source-sha>`에 두고,
  `~/.config/seorilabs/bin`에는 작은 launcher, module, install receipt만 둔다.
- 고정 `stage1-process-boundary-v2.json`은 launcher, module, relay digest만 증명한다. 변경 가능한 계약
  digest와 controller/source SHA는 source별 `stage1-local-source.json`이 고정한다.
- host record는 `/usr/local/libexec/seorilabs-p2-host-fs-boundary publish-record <fixed-id>`만 쓴다.
  fixed pending entry를 identity-bound로 복구하고 file과 parent directory를 `fsync`한 뒤
  `renameat2 RENAME_NOREPLACE`로 게시한다. plaintext fallback, caller 지정 path, overwrite, rotate,
  delete interface는 없다.
- SSH password는 값이 아니라 owner-only password file path만 controller에 전달한다. native relay가
  exact `/usr/bin/ssh`, host/IP, option, remote command와 parent process를 검증하고 SSH 및 sudo prompt에
  직접 공급한다. privileged payload는 먼저 SHA-256 이름의 owner-only remote file로 전송·readback하고
  root target은 그 파일만 별도 FD로 연다. sudo stdin에는 password만 존재하며 target stdin은
  `/dev/null`이라 cached credential이나 `NOPASSWD`에서도 password가 payload로 넘어가지 않는다.
  password는 argv, 환경, 로그, stdout에 넣지 않는다.
- unknown response는 mutation을 반복하지 않는다. 동일 action을 다시 실행하면 remote record와 exact
  digest를 먼저 읽는다. artifact만 남은 crash state는 current live inventory와 연결한 evidence를
  복구한 뒤 로컬 decrypt/restore 비교가 최종 진위를 판정한다.

## 실행 순서

모든 명령은 최신 검토·커밋된 clean source에서 실행한다. 아래 `<node-v24-absolute>`는 먼저
`command -v node`와 `node --version`으로 확인한 Node `v24.16.0`의 절대 경로다. `<...>` 값은 바로 앞
plan receipt에서 복사하는 공개 SHA 또는 confirmation이며 secret이 아니다.

### 1. 로컬 process boundary와 exact source 설치

최신 main 기반 clean isolated worktree에서 사용자 권한으로 source-built artifact와 exact git archive의
confirmation을 만든다. primary checkout 경로는 실행 경로로 사용하지 않는다.

```bash
<node-v24-absolute> scripts/fleet/bootstrap-p2-stage1-local-hardening.mjs plan
```

apply도 동일 사용자 권한으로 실행하며 local sudo는 필요하지 않다. 기존 target이 하나라도 다른
digest, inode, mode이면 덮어쓰지 않고 중단한다. `.local`과 `.local/share`의 기존 안전한 `0755`는
유지하고 agent가 관리하는 `share/seorilabs/fleet-p2`부터 `0700`을 강제한다.

```bash
<node-v24-absolute> scripts/fleet/bootstrap-p2-stage1-local-hardening.mjs apply \
  --source-sha=<plan-source-sha> \
  --archive-sha=<plan-archive-sha256> \
  --lock-sha=<plan-package-lock-sha256> \
  --controller-sha=<plan-controller-sha256> \
  --launcher-sha=<plan-launcher-sha256> \
  --module-sha=<plan-module-sha256> \
  --relay-sha=<plan-relay-sha256> \
  --confirmation=<plan-confirmation>
```

완료 상태는 `P2_STAGE1_LOCAL_PROCESS_BOUNDARY_READY`다. launcher, process module, SSH relay와
boundary receipt는 각각 `~/.config/seorilabs/bin/<helper>-<source-sha>`에 create-only로 설치한다.
기존 source의 helper는 덮어쓰지 않으므로 새 보안 경계도 exact source 단위로 갱신할 수 있다. source receipt에는 archive, lockfile,
controller, runtime manifest digest가 고정된다. source와 dependency tree에는 symlink가 없고 file은
`0400`, private directory는 `0700`이다. power loss로 receipt 이전 partial state가 남으면 같은 exact
apply가 기존 file을 검증한 뒤 missing file만 create-only로 채운다. SSH relay는 user-owned
`0500`으로 고정한다. 이후 `<stage1>`은 다음 fixed prefix를 뜻한다.

```text
~/.config/seorilabs/bin/seori-auth-native-<source-sha> launch-local-controller \
  --source-sha=<source-sha> \
  --controller-sha256=<controller-sha256> \
  --receipt-sha256=<source-receipt-sha256> \
  -- <node-v24-absolute> \
  ~/.local/share/seorilabs/fleet-p2/<source-sha>/scripts/fleet/provision-p2-stage1.mjs
```

`source-sha`, `controller-sha256`, `source-receipt-sha256`는 apply 공개 receipt의 값이다. password나
key가 아니다. current UID를 완전히 장악한 공격자는 user-owned helper와 command를 함께 바꿀 수 있다는
한계가 있으므로 각 실행마다 native held-FD, digest, inode, full runtime manifest를 다시 검증한다. root
`/usr/local/libexec` 설치는 선택적 추가 강화일 뿐 Stage 1의 실행 전제나 무인 운영 gate가 아니다.

### 2. 두 local logical credential bootstrap

```bash
<stage1> plan

<stage1> bootstrap-attestor \
  --confirmation=<plan-confirmations-attestor> \
  --pre-backup-sha=fe37a8fc8f9c975c2583aec56635c0655e34f1b5df51c0686231566c9470826c \
  --pre-backup-file-count=8880 \
  --pre-backup-restore-verified=true
```

private-only power-loss state는 private key에서 public key를 다시 derive하고 missing public/catalog만
create-only로 완성한다. public-only, private/public mismatch, catalog drift는 자동 삭제하지 않고
`P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED`로 중단한다.
성공 응답의 `postBootstrapBackup`은 새 local/BeeStation archive의 동일 SHA-256, file count와
`isolatedRestoreVerified=true`만 공개한다. receipt signature나 artifact readback이 이후 drift하면 호스트
변경 전에 fail-closed한다. 로컬 원본은 exact `0600`을 유지한다. BeeStation CloudStorage가 동기화 중
owner execute bit를 재부여하는 실제 filesystem 동작 때문에 원격 복제본 archive와 checksum만 owner-only
`0600` 또는 `0700`을 허용하며, owner·inode·link count·size·mtime·ctime과 content digest는 그대로
exact readback한다. group/world permission은 어느 경우에도 허용하지 않는다.

### 3. exact source를 세 호스트에 bootstrap

각 host마다 plan의 SHA와 confirmation을 그대로 사용한다. SSH password file은 현재 사용자 소유
regular file, mode `0600` 또는 그보다 엄격해야 한다.

```bash
<stage1> source-plan --host=<rpi5-or-rpi4001-or-seori-m6-01>

<stage1> bootstrap-source \
  --host=<exact-host> \
  --confirmation=<source-plan-confirmation> \
  --ssh-password-file=/tmp/ssh.txt
```

remote bootstrap은 git archive SHA, `package-lock.json` SHA, `npm ci --ignore-scripts`, source-built native
helper digest를 receipt에 고정한다. canonical launcher, process module, filesystem boundary는 root-owned
create-only 또는 exact readback만 허용한다. 완료 상태는 `P2_STAGE1_SOURCE_READY`다.

### 4. 두 Tang 서버 provision

아래 작업은 package 설치, socket override, `tangd.socket` enable/start와 최초 Tang key 생성을 포함한다.
rotate/delete는 하지 않는다. 각 서버에 대해 Stage 1 plan의 `tangProvision` confirmation을 사용한다.

```bash
<stage1> provision-tang \
  --server=<rpi4001-or-seori-m6-01> \
  --source-sha=<source-plan-source-sha> \
  --confirmation=<plan-confirmations-tangProvision-for-server> \
  --ssh-password-file=/tmp/ssh.txt
```

완료 상태 `TANG_SERVER_KEYS_BACKUP_REQUIRED`는 service readback까지 통과했지만 backup gate는 아직 열려
있지 않다는 뜻이다.

### 5. encrypted backup, isolated restore, signed evidence

```bash
<stage1> backup-tang \
  --server=<rpi4001-or-seori-m6-01> \
  --source-sha=<source-plan-source-sha> \
  --confirmation=<plan-confirmations-tang-for-server> \
  --ssh-password-file=/tmp/ssh.txt
```

각 서버의 완료 상태는 `TANG_BACKUP_SIGNED_AND_CATALOGED`다. canonical
`~/.config/seorilabs/seori-auth/tang/<node>/`에는 encrypted artifact, signed private evidence, 공개 server
attestation이 create-only로 들어가고 catalog shard가 등록된다. stdout에는 digest와 공개 identity만
나온다.

### 6. RPI5에 공개 trust evidence 전달

두 server attestation이 모두 검증된 뒤에만 실행한다.

```bash
<stage1> deliver-rpi5-evidence \
  --source-sha=<rpi5-source-plan-source-sha> \
  --confirmation=<plan-confirmations-rpi5> \
  --ssh-password-file=/tmp/ssh.txt
```

완료 상태는 `RPI5_TANG_TRUST_EVIDENCE_INSTALLED`다. 여기까지가 Stage 1의 끝이다. 이 결과는 RPI5
LUKS 생성, Clevis binding, reboot persistence 또는 Auth Broker workload 활성화를 뜻하지 않는다.

## 중단과 재개

- `*_OUTCOME_UNKNOWN`: 같은 action을 그대로 다시 실행해 readback-first로 재개한다.
- `*_DRIFT`, `*_PARTIAL_OR_DRIFT`: 자동 overwrite/delete하지 말고 exact path, inode, digest를 조사한다.
- `P2_STAGE1_LOCAL_*_REQUIRED`: 로컬 native boundary 또는 exact source receipt가 충족되지 않은 상태다.
- `P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED`: key material을 새로 만들거나 삭제하지 않는다.
- host identity, initial mount namespace, Node/npm version, source receipt, relay command 중 하나가 다르면
  실행하지 않는다.

Stage 1 이후 RPI5 16 GiB LUKS 생성과 reboot는 별도 승인과
`docs/migration/fleet-p2-host-encryption-provisioning.md`의 backup/apply/reboot gate를 사용한다.
