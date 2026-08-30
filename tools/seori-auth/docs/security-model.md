# 보안 모델과 운영 중단 조건

## 보호 대상

- canonical credential과 실행 복제본의 값
- browser cookie와 authenticated storage state
- TOTP seed, recovery code, trusted-device 승인
- release artifact와 승인된 provider account의 무결성

## 신뢰 대상

- policy를 생성하는 control plane
- logical credential ID를 실행 복제본으로 해석하는 `loadSecret` callback
- 코드 리뷰를 통과한 adapter executable과 `buildArgs`
- workload identity와 generation source
- owner-only Unix socket, broker-held journal MAC key, trusted control-plane checkpoint adapter,
  encrypted Browser Vault key를 관리하는 broker process
- 검토된 native helper binary와 UID/GID/PID를 scheduler principal로 해석하는 resolver
- 서로 다른 workload identity의 password loader와 TOTP signer
- Kubernetes mTLS CA, exact SPIFFE URI SAN, scheduler Ed25519 run-attestation signer
- internal provider control-plane을 호출하는 exact Backoffice SPIFFE identity와 root-owned
  endpoint scope/runtime adapter registry

에이전트 prompt, 웹페이지 텍스트, repository 입력, artifact 이름, child process 출력은
신뢰하지 않습니다. 특히 웹페이지의 prompt injection은 policy나 secret export 기능을
추가할 권한이 없습니다.

## 보장

- 정책과 lease의 exact match만 허용하며 domain suffix 또는 wildcard를 사용하지 않음
- lease 발급 후 policy 또는 credential generation이 바뀌면 실행 거부
- 기존 durable record mutation은 expected generation CAS로만 수행
- approval ID의 `maxUses=1`은 credential checkout 발급 journal mutation에서 예약하며,
  exact idempotency replay만 기존 checkout을 반환
- subject, run, repository, worker가 하나라도 다르면 capability 재사용 거부
- 실행 실패를 포함해 secret load 전에 lease를 소비하여 replay 방지
- child가 받는 secret을 argv와 environment에서 제외
- audit callback에 child 출력이나 secret을 전달하지 않음
- child stdout/stderr를 저장·반환하지 않고 output byte 상한과 status만 사용
- account별 browser checkout 동시 1개, 고정 5분 TTL과 성공 1회 사용. 잠금은 native
  OS advisory lock이며 잠금 파일 만료시각이나 unlink 경쟁으로 소유권을 판정하지 않음
- browser 완료는 provider/account/team/workspace/app 공개 identity readback이 기대값과
  정확히 같을 때만 generation과 상태 변경
- browser adapter 실행 전 `CHECKED_OUT -> CLAIMED` durable CAS를 완료하고, CLAIMED 상태의
  crash/불명 결과는 provider readback으로만 종결하며 adapter를 다시 실행하지 않음
- CAPTCHA/MFA/약관 등 interactive gate는 durable `ReauthRequest`와 연결하고 exact trusted
  resolution 전까지 같은 run/provider/account/app의 새 checkout을 차단
- browser HTTP 응답에는 opaque capability ID와 공개 identity만 포함
- schema v2 journal의 record 순서, mutation, audit를 HMAC chain으로 인증하고, 각 fsync 뒤
  public head를 trusted control-plane CAS와 exact readback으로 확정해 tail 삭제/rollback을
  startup에서 거부. append 전에 strict public
  control/audit schema를 검증해 secret-bearing 필드나 비-JSON 객체를 먼저 디스크에 쓰지 않음
- provider/account/role별 profile을 AES-256-GCM으로 저장하고 clone은 owner-only runtime
  directory에만 생성하며 provider/account별 filesystem lock으로 프로세스 간 동시 실행 1개.
  capability는 credential lease, expected profile generation, source SHA, exact origin/redirect,
  action, resource, artifact, approval, subject/run/repo/worker와 exact binding
- origin, redirect chain, provider/account/team/workspace/app ID를 factor 주입 직전과 직후에
  exact match하고 capture/export/clipboard/network control이 하나라도 열리면 주입 전 중단
- Linux `SO_PEERCRED`, macOS `getpeereid`와 `LOCAL_PEERPID`로 HTTP body 밖의 peer를 증명
- native launcher가 adapter에 `RLIMIT_CORE=0`과 OS non-dumpable 정책을 적용
- projected WIF token은 read-only mount root 아래 고정 leaf만 `openat2`로 열어, digest가
  고정된 Secret Manager child의 FD4로 한 번 전달하고 child가 읽은 즉시 descriptor를 닫음
- password/TOTP factor는 physical resource name을 선택할 수 없고 logical credential
  ID/generation만 요청하며, role별 public GSA/WIF/config digest와 실제 mounted config가
  readiness 전에 exact match
- native advisory lock 하나가 durable journal writer를 process 단위로 직렬화하며 crash 뒤
  stale lock inode는 OS lock ownership 없이 writer 권한을 만들지 못함
- browser timeout은 AbortSignal, native kill acknowledgement, adapter promise settlement를
  모두 확인하고 그 전에는 clone/session을 reclaim 또는 reuse하지 않음
- ordered auth fallback은 같은 run의 앞선 전략 실패를 journal의 non-secret digest로 증명
- signed `actionClass` 또는 production environment가 capability 문자열과 무관하게
  `per_run` approval을 강제
- provider grant 등록·검증·소비·결과·observation readback을 run/repo/SHA/binding hash와
  generation CAS에 고정하고 HMAC journal 없이 provider grant 등록을 거부
- provider grant를 외부 동작 전에 한 번 소비하며 불명 결과 뒤 같은 command를 재실행하지
  않고 새 `READBACK_FIRST` execution만 허용
- provider native adapter에는 secret fd3, canonical public command fd4, strict public result
  fd5만 제공하고 stdout/stderr, argv, environment에는 secret을 전달하지 않음

## 보장하지 않는 것

- 같은 host의 root 또는 kernel compromise
- trusted adapter가 secret을 변형해 유출하는 행위
- Node.js heap에서 secret을 완전 삭제하는 것
- provider가 session을 조기 폐기하거나 새 MFA challenge를 요구하지 않는 것
- opaque capability 밖에서 browser profile을 복사하거나 cookie를 탈취한 같은 host 공격
- Kubernetes의 다른 binding이 부여한 권한을 이 패키지의 Role로 취소하는 것
- trusted checkpoint control plane 자체가 손상되어 journal과 checkpoint를 함께 과거 상태로
  되돌린 공격
- NetworkPolicy만으로 DNS 이름이나 TLS provider identity를 검증하는 것

따라서 broker는 전용 host/container, read-only root filesystem, 분리된 PID namespace,
egress allowlist, application-layer encrypted secret store와 함께 운영해야 합니다. worker와
broker가 같은 Kubernetes Pod에 있더라도 worker에는 projected API token, credential
volume, durable state volume을 mount하지 않습니다.

native helper는 adapter child에 `RLIMIT_CORE=0`과 OS non-dumpable 정책을 적용합니다.
broker process 자체도 같은 helper를 entrypoint로 사용해야 합니다. helper checksum이
승인값과 다르거나 group/world write가 허용된 경로이면 시작하지 않습니다. production
image에서는 broker identity가 수정할 수 없는 root 소유 read-only layer로 고정합니다.
`SeoriAuthBroker`와 `LocalAuthDaemon`은 launcher 없는 credential adapter 등록을 거부하며
이를 끄는 runtime option을 제공하지 않습니다. browser adapter도
`NativeSecurityBoundary.browserAdapter`가 발급한 abort/terminate 계약이 없으면 daemon
생성 단계에서 거부합니다.

Kubernetes runtime은 TLS 1.3 mutual authentication을 사용하며 certificate의 URI SAN을
exact SPIFFE allowlist와 비교합니다. broker 요청은 여기에 scheduler가 서명한 5분 이하
run/repo/worker attestation을 추가로 요구하고 nonce digest를 HMAC durable journal에서 한 번
소비합니다. 소비 CAS가 sync된 뒤에만 인증을 성공시키므로 broker restart도 replay window를
다시 열지 않습니다. password loader와 TOTP signer는 broker SPIFFE ID만 받으며 secret
조회·export route가 없습니다.
내부 provider control-plane route는 이 공통 검증 뒤에도 runtime에 고정된 exact Backoffice
SPIFFE ID를 한 번 더 요구합니다. 일반 worker certificate로는 경로가 존재해도 접근할 수
없고, internal authorizer가 없는 local daemon에서는 route 자체를 `404`로 숨깁니다.

## 중단 조건

다음 상태에서는 새 password/TOTP를 추측하거나 반복 주입하지 않습니다.

- credential 또는 policy generation 불일치
- exact origin/redirect 불일치
- account/team/workspace 공개 ID 불일치
- CAPTCHA, passkey, SMS, push, trusted-device 승인, SSO, account recovery
- 약관·법적 동의, 권한 변경, key 회전, 공개 출시
- 실행 복제본 누락·빈 값·ambiguous logical reference

사람이 trusted UI에서 복구한 뒤 기존 lease를 폐기하고 새 lease를 발급합니다.

## 로컬 HTTP 경계

daemon의 공개 auth surface는 Unix domain socket의 `POST` 다섯 route로 유지됩니다.
Backoffice 전용 `/internal/control-plane/provider-grants` 하위 경로는 exact mTLS SPIFFE와
Ed25519 attestation을 동시에 통과한 production broker에서만 활성화됩니다. JSON 오류 응답은
machine code만 반환해 입력값이나 내부 오류를 반사하지
않습니다. body는 64 KiB로 제한되고 임의 query, executable, argument, environment,
profile path는 입력 계약에 없습니다.

상태 journal은 owner-only regular file 하나에 sequence가 연속인 JSONL envelope를
append하고 각 envelope에 `ProviderGrant`를 포함한 non-secret state mutation과
`AuthAuditEvent`를 함께
기록합니다. 호환 모드 schema v1은 sequence만 검사합니다. production은 32-byte
broker-held key와 `requireIntegrity: true`를 사용해 schema v2 HMAC/hash chain만
허용합니다. record는 append 전에 같은 strict validator로 plain JSON, exact mutation/audit schema를
확인합니다. 중간에 잘린 record, sequence 역행, MAC/previous-MAC 불일치, symlink,
group/other-readable mode는 fail-closed입니다. static expected head 설정은 허용하지 않습니다.
startup은 trusted control plane의 current checkpoint를 읽고 local exact head와 비교합니다.
append는 fsync, deterministic generation CAS, exact readback 순서이며 readback으로 next head를
증명하기 전에는 mutation을 메모리에 적용하지 않습니다. CAS 결과가 불명이더라도 next head
readback이 exact하면 pending latch와 readiness를 해제해 다음 독립 CAS를 허용하고, 그렇지 않으면
pending transition을 유지한 채 readiness를 제거하고 state를 닫습니다. pending은 authority
origin/SPIFFE, journal, expected generation/local head/authority digest, deterministic idempotency key,
next generation/head 전체에 고정되며 해소 전에는 같은 요청이나 다른 advance를 재전송하지 않습니다.
재시작 시 local이 trusted
head의 HMAC-valid 직계 자식 하나인 crash window만 같은 idempotency CAS로 복구합니다. MAC key와
secret 실행 복제본은 journal이나 checkpoint에 쓰지 않습니다.
authority transport는 signer의 고정 cluster HTTPS origin, 세 route, TLS 1.3, exact DNS와
server/client SPIFFE SAN만 허용합니다. genesis authority digest는 공개 CAS predecessor로만
관리하고 local genesis HMAC head로 해석하지 않습니다. timeout·connection reset·잘못된 JSON은
원문을 반사하지 않는 stable 오류 또는 `UNKNOWN`으로 축약하고 같은 advance를 재전송하지 않습니다.
outbound client identity는 inbound broker service identity와 별도 Secret으로 분리하며 exact client
SPIFFE URI SAN 하나, matching key, `0440` execution copy만 허용합니다. renderer는 복제본을 참조만
하고 생성·동기화하지 않습니다.
journal을 열기 전 native helper가 broker 소유 FD에 non-blocking advisory writer lock을
걸고, broker가 그 FD를 닫을 때까지 같은 open file description을 보유합니다. 따라서 각
process의 메모리 queue만으로는
막을 수 없던 다중 broker approval reservation 경쟁도 하나의 replay/append writer로
직렬화됩니다.

startup replay는 TTL이 지난 `CHECKED_OUT`을 새 generation의 `AVAILABLE`로 journal에
회수하고, 남아 있는 `CLAIMED`는 readback-only recovery 대상으로 표시합니다. 같은
프로세스에서 adapter 오류가 반환된 경우도 즉시 같은 recovery 상태로 전환합니다.
recovery는 저장된 authorization을 exact-match하되 이미 실행된 동작을 재허가하는 것이
아니므로 approval 만료나 credential generation 변경 뒤에도 provider readback은 허용합니다.

mode `0600`만으로 같은 UID process를 분리할 수 없으므로 broker는 worker와 다른 OS
identity로 실행하고 state/Vault directory를 worker mount에서 제외합니다.

HTTP body의 subject/run/repository/worker는 인증 근거가 아닙니다. 필수
`authenticatePrincipal(socket)` callback은 `NativeSecurityBoundary`가 읽은 peer
UID/GID/PID와 agent 입력 밖의 scheduler-issued run capability를 결합해 principal을
증명해야 하며, daemon은 그 결과와 body claim이 exact match일 때만 다음 단계로
진행합니다. Node의 private accepted-socket fd는 지원 버전을 Node 24로 고정하고 native
integration test로 보호합니다.

`EncryptedBrowserVault`는 암호화 profile을 capability에 연결하고 내부 trusted callback에만
ephemeral clone path를 제공합니다. clone 종료 시 폐기하고 exact identity가 일치할 때만
갱신본을 다시 암호화합니다. JSON serialization 중 민감 문자열이 Node heap에서 즉시
완전 삭제된다고 보장하지 않으므로 broker는 전용 container/PID namespace와 memory
limit를 사용합니다. 실제 provider DOM selector와 identity readback 구현은 provider별
검토된 adapter가 공급하며, 해당 binding·egress allowlist·fake-account canary가 없으면
그 provider의 browser 자동화를 활성화하지 않습니다.

broker startup은 runtime의 `checkout-*` clone마다 해당 account advisory lock을 먼저
획득한 뒤, 현재 소유자가 없는 clone만 제거합니다. 정상 종료와 TTL timer도 같은
clone/lock을 idempotent하게 해제합니다. process supervisor는 broker가 종료된 뒤
`scripts/cleanup-browser-runtime.mjs`를 실행합니다. Kubernetes의 tmpfs `emptyDir`은 Pod
종료 시 함께 사라지고 같은 Pod 안의 container restart는 startup cleanup으로 회수합니다.
