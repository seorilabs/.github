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
- owner-only Unix socket, broker-held journal MAC key/head checkpoint, encrypted Browser
  Vault key를 관리하는 broker process
- 검토된 native helper binary와 UID/GID/PID를 scheduler principal로 해석하는 resolver
- 서로 다른 workload identity의 password loader와 TOTP signer

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
- schema v2 journal의 record 순서, mutation, audit를 HMAC chain으로 인증하고 외부 head
  checkpoint가 주어지면 tail 삭제/rollback도 startup에서 거부
- provider/account/role별 profile을 AES-256-GCM으로 저장하고 clone은 owner-only runtime
  directory에만 생성하며 provider/account별 filesystem lock으로 프로세스 간 동시 실행 1개.
  capability는 expected profile generation, source SHA, subject/run/repo/worker와 exact binding
- origin, redirect chain, provider/account/team/workspace/app ID를 factor 주입 직전과 직후에
  exact match하고 capture/export/clipboard/network control이 하나라도 열리면 주입 전 중단
- Linux `SO_PEERCRED`, macOS `getpeereid`와 `LOCAL_PEERPID`로 HTTP body 밖의 peer를 증명
- native launcher가 adapter에 `RLIMIT_CORE=0`과 OS non-dumpable 정책을 적용

## 보장하지 않는 것

- 같은 host의 root 또는 kernel compromise
- trusted adapter가 secret을 변형해 유출하는 행위
- Node.js heap에서 secret을 완전 삭제하는 것
- provider가 session을 조기 폐기하거나 새 MFA challenge를 요구하지 않는 것
- opaque capability 밖에서 browser profile을 복사하거나 cookie를 탈취한 같은 host 공격
- Kubernetes의 다른 binding이 부여한 권한을 이 패키지의 Role로 취소하는 것
- 외부 trusted head checkpoint 없이 journal 전체를 과거의 유효한 snapshot으로 되돌린 공격
- NetworkPolicy만으로 DNS 이름이나 TLS provider identity를 검증하는 것

따라서 broker는 전용 host/container, read-only root filesystem, 분리된 PID namespace,
egress allowlist, encrypted-at-rest secret store와 함께 운영해야 합니다. worker와
broker가 같은 Kubernetes Pod에 있더라도 worker에는 projected API token, credential
volume, durable state volume을 mount하지 않습니다.

native helper는 adapter child에 `RLIMIT_CORE=0`과 OS non-dumpable 정책을 적용합니다.
broker process 자체도 같은 helper를 entrypoint로 사용해야 합니다. helper checksum이
승인값과 다르거나 group/world write가 허용된 경로이면 시작하지 않습니다. production
image에서는 broker identity가 수정할 수 없는 root 소유 read-only layer로 고정합니다.

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
기록합니다. 호환 모드 schema v1은 sequence만 검사합니다. production은 32-byte
broker-held key와 `requireIntegrity: true`를 사용해 schema v2 HMAC/hash chain만
허용합니다. 중간에 잘린 record, sequence 역행, MAC/previous-MAC 불일치, symlink,
group/other-readable mode는 fail-closed입니다. control plane에 보관한 마지막 head MAC을
`expectedJournalHeadMac`으로 주면 journal tail rollback도 거부합니다. MAC key와 secret
실행 복제본은 journal에 쓰지 않습니다.

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
