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
- owner-only Unix socket과 append-only durable journal을 관리하는 broker process

에이전트 prompt, 웹페이지 텍스트, repository 입력, artifact 이름, child process 출력은
신뢰하지 않습니다. 특히 웹페이지의 prompt injection은 policy나 secret export 기능을
추가할 권한이 없습니다.

## 보장

- 정책과 lease의 exact match만 허용하며 domain suffix 또는 wildcard를 사용하지 않음
- lease 발급 후 policy 또는 credential generation이 바뀌면 실행 거부
- 기존 durable record mutation은 expected generation CAS로만 수행
- subject, run, repository, worker가 하나라도 다르면 capability 재사용 거부
- 실행 실패를 포함해 secret load 전에 lease를 소비하여 replay 방지
- child가 받는 secret을 argv와 environment에서 제외
- audit callback에 child 출력이나 secret을 전달하지 않음
- child stdout/stderr를 저장·반환하지 않고 output byte 상한과 status만 사용
- account별 browser checkout 동시 1개, 고정 5분 TTL과 성공 1회 사용
- browser 완료는 provider/account/team/workspace/app 공개 identity readback이 기대값과
  정확히 같을 때만 generation과 상태 변경
- browser HTTP 응답에는 opaque capability ID와 공개 identity만 포함

## 보장하지 않는 것

- 같은 host의 root 또는 kernel compromise
- trusted adapter가 secret을 변형해 유출하는 행위
- Node.js heap에서 secret을 완전 삭제하는 것
- provider가 session을 조기 폐기하거나 새 MFA challenge를 요구하지 않는 것
- opaque capability 밖에서 browser profile을 복사하거나 cookie를 탈취한 같은 host 공격
- Kubernetes의 다른 binding이 부여한 권한을 이 패키지의 Role로 취소하는 것

따라서 broker는 전용 host/container, read-only root filesystem, 분리된 PID namespace,
egress allowlist, encrypted-at-rest secret store와 함께 운영해야 합니다. worker와
broker가 같은 Kubernetes Pod에 있더라도 worker에는 projected API token, credential
volume, durable state volume을 mount하지 않습니다.

현재 Node reference는 `RLIMIT_CORE=0` 또는 process dumpability를 설정하지 못합니다.
production attestor/launcher가 native wrapper, launchd 또는 container runtime 경계에서
broker와 adapter child 모두에 이를 강제하기 전에는 secret execution을 활성화하지
않습니다.

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

daemon은 Unix domain socket 이외의 listener를 만들지 않으며 `POST` 다섯 route만
처리합니다. JSON 오류 응답은 machine code만 반환해 입력값이나 내부 오류를 반사하지
않습니다. body는 64 KiB로 제한되고 임의 query, executable, argument, environment,
profile path는 입력 계약에 없습니다.

상태 journal은 owner-only regular file 하나에 sequence가 연속인 JSONL envelope를
append하고 각 envelope에 non-secret state mutation과 `AuthAuditEvent`를 함께
기록합니다. 중간에 잘린 record, sequence 역행, symlink, group/other-readable mode는
fail-closed입니다. secret 실행 복제본은 journal 생성 이후에도 `loadSecret` callback과
fd3 사이에서만 존재합니다.

단, mode `0600`은 다른 UID를 막을 뿐 같은 macOS UID의 agent process를 막지 못하고,
sequence 검증은 같은 UID의 rewrite를 탐지할 cryptographic integrity가 아닙니다.
production에서는 broker를 worker와 다른 OS identity로 실행해 state directory를
분리하고, broker-held MAC/hash chain 또는 동등한 append-only storage로 startup
integrity를 검증해야 합니다.

HTTP body의 subject/run/repository/worker는 인증 근거가 아닙니다. 필수
`authenticatePrincipal(socket)` callback이 native peer credential과 agent 입력 밖의
scheduler-issued run capability 또는 inherited FD로 principal을 증명해야 하며, daemon은
그 결과와 body claim이 exact match일 때만 다음 단계로 진행합니다. Node 표준 UDS에는
portable peer credential API가 없으므로 이 production adapter가 없는 reference daemon은
배포 불가입니다.

또한 현재 구현은 `BrowserSessionBinding` 상태와 opaque capability 계약까지만
제공합니다. 실제 profile/cookie를 agent와 분리해 보관하고 capability를 session에
연결하며 provider identity를 독립적으로 읽는 Browser Vault provider adapter는
구현하지 않았습니다. 해당 adapter와 격리 검증 전에는 browser 자동화를 활성화하지
않습니다.
