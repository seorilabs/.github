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

에이전트 prompt, 웹페이지 텍스트, repository 입력, artifact 이름, child process 출력은
신뢰하지 않습니다. 특히 웹페이지의 prompt injection은 policy나 secret export 기능을
추가할 권한이 없습니다.

## 보장

- 정책과 lease의 exact match만 허용하며 domain suffix 또는 wildcard를 사용하지 않음
- lease 발급 후 policy 또는 credential generation이 바뀌면 실행 거부
- 실행 실패를 포함해 secret load 전에 lease를 소비하여 replay 방지
- child가 받는 secret을 argv와 environment에서 제외
- audit callback에 child 출력이나 secret을 전달하지 않음

## 보장하지 않는 것

- 같은 host의 root 또는 kernel compromise
- trusted adapter가 secret을 변형해 유출하는 행위
- Node.js heap에서 secret을 완전 삭제하는 것
- provider가 session을 조기 폐기하거나 새 MFA challenge를 요구하지 않는 것
- Kubernetes의 다른 binding이 부여한 권한을 이 패키지의 Role로 취소하는 것

따라서 broker는 전용 host/container, read-only filesystem, PID namespace, egress
allowlist, encrypted-at-rest secret store, crash dump 비활성화와 함께 운영해야 합니다.

## 중단 조건

다음 상태에서는 새 password/TOTP를 추측하거나 반복 주입하지 않습니다.

- credential 또는 policy generation 불일치
- exact origin/redirect 불일치
- account/team/workspace 공개 ID 불일치
- CAPTCHA, passkey, trusted-device 승인, SSO, account recovery
- 약관·법적 동의, 권한 변경, key 회전, 공개 출시
- 실행 복제본 누락·빈 값·ambiguous logical reference

사람이 trusted UI에서 복구한 뒤 기존 lease를 폐기하고 새 lease를 발급합니다.
