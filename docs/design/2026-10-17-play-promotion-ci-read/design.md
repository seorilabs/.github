# Play 승격의 CI 근거 읽기 권한

승인 근거: Bloomhand 빌드 경로 보완·후속 후보 공개 제안에 대한 사용자 “이어서 진행해”(2026-10-17). Bloomhand PR77의 연계 변경이다. 테스트·출시 범위를 줄이거나 검증기를 우회하지 않는다.

승격 workflow가 verify-development-evidence를 실행하고 이 검증기는 실제 GitHub Actions run을 API로 조회한다. 명시적 permissions에 actions가 없으면 none이므로 CI_RUN_UNVERIFIED로 멈춘다. 중앙 reusable permissions에 actions:read 한 줄을 더하고 Bloomhand caller의 상한도 함께 맞춘다. contents:read·id-token:write와 승격 버전·원장·서명·WIF·rollout·심사 조건은 그대로다. 마켓 쓰기 권한을 추가하지 않는다.

인수조건: YAML 실제 permissions.actions=read이며 현재 contents/id-token 유지. 회귀 시험은 수정 전 undefined로 실패하고 수정 후 통과. npm test·pack:check·actionlint와 PR CI, 읽기전용 교차 코드리뷰를 수행한다. 실제 Play 승격은 Bloomhand native 실행과 before-release 통과 뒤 해당 태그로만 실행하므로 이 정적 검사와 구분한다. UI·SDK·사용자 데이터 변경이 없어 시각/실기기 회귀는 중앙 변경 자체에는 해당 없음이다. 실제 앱은 기존 승인 L3 dev·Android·iOS를 유지한다.

L1 dev static 계약 검사. 정본 테스트 계획은 같은 폴더 test-plan.json. 구현→Ready PR→교차리뷰·CI→squash merge→live 소스 재조회 순서. 다른 릴리스 workflow나 중앙 계약의 허용 범위를 바꾸지 않는다. 문제가 있으면 실제 승격 전 중단하고 후속 후보로 수정한다.

## 교차 리뷰의 caller 이관 조건

Claude 1회 리뷰P2 수용. 실제 활성 원본42개 저장소·265개 workflow를 API로 읽어 직접 호출14개가 모두 actions:read 없이 명시적 permissions를 쓰는 것을 확인했다. Bloomhand는 PR77에 포함한다. 나머지13개는 외부 작업 기록에 exact head·한 줄 patch·SHA를 준비했고, 사용자가 “13개 호출부 선행 보완까지 진행 (권장)”으로 범위 확장을 승인했다. 외부 manifest의13개 저장소에 권한 한 줄만 보완하고 기존 CI·교차리뷰·PR·live 재조회를 수행하며 마켓 배포는 하지 않는다. 14개 호출부 전부 먼저 보완·검증·병합·live 재조회하기 전 이 중앙 PR을 병합하지 않는다. 원문 리뷰와 수용 답변은 PR271에 보존한다. README에 caller 계약과 순서를 적으며 코드리뷰를 통과했다는 이유로 호환성 결함을 넘기지 않는다.
