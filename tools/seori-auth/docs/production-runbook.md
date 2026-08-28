# Seori Auth Broker 운영 활성화·복구 Runbook

이 문서는 실제 secret 값을 다루지 않습니다. 모든 확인은 logical credential ID,
공개 workload identity, fingerprint, generation과 checksum만 사용합니다. 실제 provider
계정 등록, TOTP enrollment, key 생성·회전, Kubernetes apply는 각각 별도 승인 작업입니다.

## 1. 변경 불가능한 입력 고정

다음을 하나의 배포 revision에 고정합니다.

- repository source SHA와 `package-lock.json`
- native helper SHA-256, broker/factor image digest
- signed policy generation과 adapter digest
- 공개 provider/account/team/workspace/app ID
- exact primary origin, 순서가 고정된 redirect origin, egress-proxy hostname allowlist
- 순서가 고정된 exact auth factor fallback strategy, signed `actionClass`, action별 approval mode
- journal MAC logical ID/generation과 직전 trusted head MAC
- Browser Vault key logical ID/generation과 encrypted PVC snapshot ID
- Backoffice provider worker의 exact SPIFFE ID와 고정 internal endpoint scope
- provider native adapter executable/fixed argv digest와 logical credential generation partition

값이 빠졌거나 image가 immutable digest가 아니거나 role별 identity/config/TLS 이름이
중복되면 renderer가 중단해야 합니다. comment-only legacy 경로를 manifest 입력으로
사용하지 않습니다.

## 2. Native 경계 빌드와 검증

지원 대상은 Node 24의 Linux와 macOS입니다.

```sh
npm ci
npm run build:native
./.build/seori-auth-native self-test
npm run lint
npm test
```

`self-test`는 core soft/hard limit가 모두 0이고 Linux `dumpable=0` 또는 macOS
`denyAttach=true`여야 합니다. production image에서는 helper를 root 소유 read-only
layer에 두고 승인된 SHA-256과 `NativeSecurityBoundary.open`의 checksum이 같아야 합니다.
broker process와 모든 credential adapter/factor service entrypoint를
`seori-auth-native launch -- /absolute/executable ...`로 시작합니다.

ARM64 image는 저장소 root에서 다음처럼 빌드합니다. 실제 registry push와 digest 승격은
별도 배포 승인 뒤 수행합니다.

```sh
docker buildx build --platform linux/arm64 \
  --file tools/seori-auth/Dockerfile \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag seori-auth:canary .
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges seori-auth:canary
```

production config의 `nativeHelperSha256`, `secretAccess.nodeSha256`,
`secretAccess.childSha256`는 해당 immutable image 안의 세 파일 checksum과 같아야 합니다.
`secretAccess.configSha256`는 role별 `secret-access.json`의 exact checksum이며 renderer의
`secretAccessConfigSha256`와 같아야 합니다. 서비스는 파일의 root ownership, checksum,
numeric resource partition, WIF audience와 public GSA impersonation target을 readiness 전에
모두 검증합니다.

Unix socket의 UID/GID/PID만으로 run 권한을 만들지 않습니다. scheduler가 agent input
밖에 보관하는 run capability를 조회해 subject/run/repository/worker를 반환하고, HTTP
body와 exact match해야 합니다. 알 수 없는 PID, 종료된 run, 다른 repo/SHA는 거부합니다.

## 3. Journal과 Browser Vault

production state는 다음 조건으로만 엽니다.

```js
await DurableAuthState.open({
  directory: '/var/lib/seori-auth/state',
  writerLockProvider: nativeBoundary.lockProvider(),
  journalMacKey,
  requireIntegrity: true,
  expectedJournalHeadMac,
});
```

MAC/Vault key는 broker 전용 workload identity가 Secret Manager API로 읽어 process
memory에만 유지합니다. argv, env, 일반 파일, Kubernetes Secret, log로 전달하지 않습니다.
각 성공 append 후 `integrityCheckpoint()`의 public sequence/head MAC을 control plane에
CAS로 보관합니다. startup 시 wrong key, MAC chain 오류, incomplete line, head mismatch는
새 lease를 발급하지 않고 incident로 전환합니다.
같은 state directory는 native advisory writer lock을 획득한 broker process 하나만 열 수
있습니다. lock file은 삭제하지 않아도 되며 crash 뒤 OS ownership이 해제된 경우에만 새
broker가 같은 inode를 잠그고 replay합니다. native acquisition helper가 inherited FD에
lock을 건 뒤 broker가 같은 open file
description을 계속 보유합니다. helper 종료는 lock을 풀지 않으며 broker crash/close가 FD를
닫을 때만 커널이 소유권을 해제합니다.

Browser Vault 원본은 encrypted PVC, clone은 `emptyDir.medium: Memory`에 둡니다.
provider/account/role별 원본 하나와 provider/account별 checkout 하나만 허용합니다.
trusted browser adapter만 `withClone` callback 안에서 path를 받고, agent 응답·trace·HAR·
screenshot·artifact에는 path나 storage state를 넣지 않습니다. 종료·TTL·identity mismatch
시 clone을 폐기하며 expected identity가 모두 맞을 때만 encrypted 원본을 갱신합니다.

browser 외부 동작 전에 durable state가 `CHECKED_OUT -> CLAIMED` CAS를 완료해야 합니다.
broker가 CLAIMED 상태에서 종료되거나 adapter 결과가 불명확하면 재시작/재요청은 adapter를
실행하지 않고 provider API의 artifact/action readback만 수행합니다. `SUCCEEDED`만 완료,
`NOT_APPLIED`만 새 checkout 허용, `UNKNOWN`은 CLAIMED 유지가 기준입니다. startup은 만료된
미실행 CHECKED_OUT만 AVAILABLE로 회수합니다. 이 readback은 저장된 authorization exact
binding으로만 열고 approval 만료나 credential generation 변경을 이유로 막지 않습니다.

browser adapter는 native boundary가 발급한 AbortSignal·kill-and-wait 계약이어야 합니다.
timeout 시 signal을 abort하고 kill 확인과 adapter promise settlement를 모두 기다립니다.
둘 중 하나라도 확인되지 않으면 clone을 abort하지 않고 session을 `CLAIMED`에 유지하며,
같은 daemon에서 recovery·reclaim·reuse를 모두 거부합니다.

`authStrategies`의 뒤 전략은 any-of가 아닙니다. 같은 run/repo/SHA/action/resource에서 앞선
각 전략의 `ADAPTER_FAILED`, `ADAPTER_TIMEOUT` 또는 browser `NOT_APPLIED` readback이
journal에 non-secret evidence digest로 남은 경우에만 다음 전략 checkout을 허용합니다.
infrastructure load/start 오류나 다른 run의 실패는 fallback evidence가 아닙니다.
signed `actionClass`가 protected이거나 resource environment가 `production`이면 capability
이름이 무엇이든 approval mode는 `per_run`이어야 합니다.

provider 실행은 `register -> verify -> consume -> result/observation` 순서로만 처리합니다.
grant expiry는 최대 5분, `maxUses`는 1이며 registration과 consume idempotency key를 각각
run/generation에 고정합니다. adapter 호출 전에 HMAC journal에 `CONSUMED`를 fsync합니다.
transport 단절, timeout, 잘못된 result처럼 외부 결과를 확정할 수 없는 경우 `RESULT_UNKNOWN`
이므로 consume을 재호출해 실행하지 않습니다. 별도 fleet read-only credential로 새
`READBACK_FIRST` command를 발급해 provider observation을 읽은 뒤에만 다음 상태로 넘깁니다.

broker는 startup마다 account별 native advisory lock을 획득할 수 있는 stale clone만
자동 제거합니다. systemd/launchd 같은 process supervisor는 broker process가 완전히
종료된 뒤 다음 명령을 `ExecStopPost` 상당 단계에서 실행합니다. 활성 checkout의 lock은
획득할 수 없으므로 삭제하지 않습니다.

```sh
npm run cleanup:browser-runtime -- \
  --runtime-directory=/run/seori-auth/browser \
  --native-helper=/opt/seori-auth/bin/seori-auth-native
```

명령은 clone path나 cookie를 출력하지 않고 `{"state":"CLEAN"}`만 반환해야 합니다.
Kubernetes의 tmpfs `emptyDir`은 Pod 삭제 시 폐기되며, 같은 Pod의 broker container만
재시작하는 경우 startup cleanup이 crash clone을 회수합니다.

## 4. Password/TOTP 분리

- password loader와 TOTP signer는 다른 ServiceAccount, workload identity, Secret Manager
  secret IAM을 사용합니다.
- password loader에는 TOTP seed 권한이 없고 signer에는 password 권한이 없습니다.
- signer API에는 seed read/export/list가 없고, exact origin/account 확인 뒤 30초 이내
  만료하는 코드만 trusted browser injector에 전달합니다.
- canonical registry가 `human`으로 분류한 계정의 password/TOTP, passkey, SMS, push,
  trusted-device, CAPTCHA, recovery, 약관 화면은
  `HUMAN_REAUTH_REQUIRED`로 한 번만 기록하고 자동 retry하지 않습니다.
- active `ReauthRequest`는 같은 run/provider/account/app의 새 credential checkout을 막고,
  trusted UI가 public identity와 generation을 exact-match해 resolve한 뒤 새 approval과 새
  idempotency key로만 재개합니다.

## 5. Kubernetes render gate

`scripts/render-production-k8s.mjs`에 절대 경로의 public deployment config를 전달한 뒤
schema/admission dry-run과 실제 binding을 read-only로 확인합니다. config에는 secret 값이
아니라 image digest, private registry pull Secret 이름, public Google identity/WIF audience,
selector와 port만
들어갑니다. RPI4에는 신규 workload를 배치하지 않고 검증된 RPI5 label을 node selector로
지정합니다. 기존 `k8s/production/*.yaml`은 적용할 객체가 없는 compatibility marker입니다.
`providerControlPlane`은 exact `backofficeClientSpiffeId`, 고정
`endpointScope=/internal/control-plane/provider-grants`, Backoffice signer Pod 전용 namespace/pod
exact selector를 가지며 runtime config, container startup argument, Pod annotation과
NetworkPolicy peer가 모두 같아야 합니다.

```sh
node scripts/render-production-k8s.mjs \
  --config=/absolute/path/to/public-deployment.json > rendered-auth-broker.json
kubectl apply --dry-run=client --validate=false -f rendered-auth-broker.json
kubectl apply --dry-run=server -f rendered-auth-broker.json
for sa in auth-broker password-loader totp-signer; do
  kubectl auth can-i get secrets \
    --as "system:serviceaccount:auth-broker:${sa}" -n auth-broker
  kubectl auth can-i list secrets \
    --as "system:serviceaccount:auth-broker:${sa}" -n auth-broker
  kubectl auth can-i watch secrets \
    --as "system:serviceaccount:auth-broker:${sa}" -n auth-broker
done
```

아홉 RBAC 결과는 모두 `no`여야 합니다. 추가로 확인합니다.

- namespace Pod Security `restricted` enforce/audit/warn
- 모든 container non-root, read-only root, RuntimeDefault seccomp, capabilities ALL drop
- 세 Pod의 `imagePullSecrets`가 사전 readback한 private GHCR pull Secret exact 이름과 일치하고
  node cache가 비어 있어도 digest-pinned image를 pull할 수 있음
- automount token false, explicit short-lived WIF audience만 mount
- projected token은 고정 mount root와 leaf `token`만 사용하며 native `openat2` 검증을 통과
- default deny 후 일반 trusted worker와 provider control-plane signer의 서로 분리된 exact ingress,
  factor-service 내부 통신, DNS와 egress proxy만 허용
- egress proxy가 exact provider hostname/TLS identity를 검증하고 direct Internet은 차단
- state/Vault PVC는 worker와 factor service에 mount되지 않고 storage encryption이 활성
- `providerControlPlane.backofficeClientSpiffeId`가 broker client allowlist와 같고 다른
  worker SPIFFE로 internal provider route 호출이 거부됨
- run-attestation nonce digest가 HMAC journal에 먼저 소비되고 broker 재시작 뒤 replay도 거부됨
- Role의 `rules: []`와 세 ServiceAccount의 Kubernetes Secret `get/list/watch=no`가 유지됨

## 6. Fake-account canary와 활성화

먼저 canary logical IDs와 가짜 browser profile만 연결합니다. `npm test`의 deterministic
canary는 raw/base64/hex representation이 다음 표면에 없음을 검사합니다.

- agent prompt와 tool output
- child argv/environment, broker audit/log와 MAC journal
- browser trace/capture policy와 encrypted Vault artifact
- release artifact metadata

look-alike origin, redirect 변경, wrong account/workspace/app ID, cross-repo capability reuse,
TTL/startup reclaim, concurrent duplicate complete의 adapter 1회 실행, crash readback-only,
approval ID 동시 발급 1회, wrong MAC key, journal tamper와 session revoke가 모두 fail-closed인
뒤 provider별 read-only canary를 하나씩 활성화합니다. upload/submit/public release/role/key
변경은 로그인 성공과 별개의 approval policy가 있어야 합니다.

container canary는 추가로 parent/child core dump 비활성화, fixed child argv와 digest,
projected token의 one-read FD close, symlink escape 거부, 같은 resource의 동시 accessor 거부를
검증합니다. 오류에는 token byte나 symlink target path가 포함되어서는 안 됩니다.

## 7. 중단과 rollback

이상 상태에서는 새 lease를 멈추고 기존 browser clone/session capability를 폐기합니다.
배포 rollback은 이전 승인 image digest와 **그 image가 기록한 trusted journal head**가
일치할 때만 수행합니다. encrypted PVC snapshot과 control-plane checkpoint를 함께
복원하며 journal만 잘라내거나 head MAC을 임의로 낮추지 않습니다.

credential/key 회전·폐기는 이 rollback이 아닙니다. backup과 임시 복원 검증, provider
session revoke 영향 확인, 별도 사용자 승인을 거쳐 진행합니다. 사람 재인증 뒤에는 기존
lease/capability를 재사용하지 않고 새 policy/credential generation으로 발급합니다.
