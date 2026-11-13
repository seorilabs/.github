# 첫 Apple 내부 배포 결속

사용자가 C13 준비안과 두 내부 채널 업로드를 승인한 범위다. 사용자의 로그인 완료 응답 뒤 실제 Seori Labs/HCDUXX4Z3X 계정과 기존 identity를 재사용했다. Android0.1.0(1) internal/completed와 네 Google grant 회수는 그대로 두고 Apple만 등록한다. 게임PR2·main·제품 태그와 기존 실패를 변경하지 않는다.

## 정확한 실행 대상

- grant: betta-0-1-0-apple-first-internal, SHA-256 b0899f3aaaa339310bab55091129105bad6d0ae437c8acea65a6d5817ab3c5e7
- 소스 bd78bd996987481d668185da815c6853c4e99a4b / v0.1.0 / 원장 code1 / 성공 sourceCI43281443421
- verifier 7e096896a8a7b08053d6f90a851bdc99fed67cbb
- app6834215464 / bundle com.seorilabs.bettaraising / SKU seorilabs-betta-raising / en-US / iOS
- product644d867e-46ae-4b8f-a634-f139c00d9fb6 / workflow686987D3-6AD2-4755-9679-4FDC3CAF966B
- 원격 SCM0ac812c4-8aeb-4f03-9de2-d71cd3effde6 / 실제 tag ref202ec9c6-330d-42ca-9357-965c3d8f7815
- 단일 IOS ARCHIVE / BettaAtelier / INTERNAL_ONLY / v0.1.0 수동 태그만, 다른 시작 조건 null
- 실제 product Settings에 표시된 다음 빌드 번호1. 준비 단계의 Cloud run은0개이며 Xcode의 Start First Build는 누르지 않았다. 활성화 전 workflow는 disabled다.
- TestFlight 사후 작업은 Archive - iOS를 internal group fe2b5b03-483c-4f0a-ba37-4cc1ec80452f(Internal Testers)에만 연결한다. 기존 로그인 계정의 App Store 사용자69a495e8-8026-5733-e053-5b8c7c1155b0와 새 앱 tester848779e5-29c9-4cf9-855f-a1ced9e3f1ac를 대조했으며 구성원1명이다. 계정 역할·외부 그룹·공개 링크는 변경하지 않았다.

## 서명과 근거

기존 Distribution certificate4PSTD55GTV의 DER SHA6eda0a7eefe7fa7c736644d5b6a71cf5907e70da827640817024afd5ed05acb3를 유지한다. Developer Portal에서 App Attest를 켜고 새 App Store profile RDVCC948B4를 만들었다. UUID dc049deb-da89-418f-8c08-af8d53b4e72c, SHA52f39ebfe8c37a61f7fa608cbe3adc31bc14c1caa5d54a176a8958608665ca02다. production App Attest·Sign in with Apple·get-task-allow:false·team/bundle·선택한 certificate 한 개를 원문 CMS로 검증했다. 이전 profile은 provider의 INVALID 상태와 원본 로컬 바이트를 보존하며 사용하지 않는다. 변경 전후 로컬/BeeStation 암호화 백업의 복원 검사가 모두 통과했다.

구성 지문23f445b87a94797eedc7082dd6b070a70695c8f0bc84beec6237f2448875995a와 Apple 원래 evidence SHAbe40b5db2fcf103c67abc987b3a74ed8148bd94edf10079256725341b1aaad2c, 기존10개 원본 관측을 결속한다. 최초 승인2026-11-12T15:35:59.411730+00:00과 만료2026-11-19T15:35:59.411730+00:00, 시장별2 native builds/1 accepted upload를 유지한다. Apple 업로드 접수는 아직0이다.

실제 App Store 원래 normal v2는 두 phase 모두 THREE_UI_ROUNDS_REQUIRED다. 제품 E2E blocked, nativeQaWaived:false, publicReleaseAllowed:false를 유지한다. 정상 독립 UI 회차나 실제 폰 검수 통과로 바꾸지 않는다. 운영 자료가 있는 준비 worktree의 source 사전 검사는 자체 __pycache__에서 거부됐고 이 실패를 보존했다. 별도 clean detached bd78 checkout은 두 source phase 검사와 실제 schema를 통과했다. 이는 실제 Cloud 빌드 작업트리나 과거 작업트리 전체 감사가 아니며 Cloud phase 검사는 실제 실행에서 다시 수행한다.

Cloud의 비밀 변수7개는 기존 등록된 GH operator·ASC uploader·Distribution P12와 새 앱 profile 실행 복제본만 사용한다. 공개 API가 반환하지 않는 env와 사후 작업은 실제 UI 저장 응답200의 동일 workflow resource를 다시 GET하여7개 이름·redacted_value와 정확한 group ID를 확인했다. 비밀값은 출력·파일·Git에 남기지 않았다. 저장 후 UI가 두 이름을 줄여 표시해 조회가 실패했던 기록과, 이미 존재하는 이름을 다시 추가하려다 UI validation이 거부한 기록도 보존했다. 중복된 값은 저장하지 않았다.

등록 후 reviewed bytes·원래 Release 자산·만료·실제 provider/태그/서명/claims를 다시 확인한 뒤 workflow를 켜고 정확한 tag로 첫 Cloud run을 한 번 시작한다. Apple VALID와 내부 그룹 연결을 확인한 뒤 grant를 회수하고 원본 artifact·로그·처리 기록을 NAS에 크기/SHA-256으로 다시 읽어 보관한다. 실패·접수 불명에는 자동 재실행하지 않는다.
