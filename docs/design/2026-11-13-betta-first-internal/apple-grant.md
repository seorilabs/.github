# 첫 Apple 내부 배포 결속

사용자가 C13 준비안과 두 내부 채널 업로드를 승인한 범위다. 사용자의 로그인 완료 응답 뒤 실제 Seori Labs/HCDUXX4Z3X 계정과 기존 identity를 재사용했다. Android0.1.0(1) internal/completed와 네 Google grant 회수는 그대로 두고 Apple만 등록한다. 게임PR2·main·제품 태그와 기존 실패를 변경하지 않는다.

## 정확한 실행 대상

- grant: betta-0-1-0-apple-first-internal, 활성 승인 시점 바이트 SHA-256 b0899f3aaaa339310bab55091129105bad6d0ae437c8acea65a6d5817ab3c5e7
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

## 두 실제 Cloud 실행 뒤 중단

동일한 bd78/v0.1.0 후보에서 run19199616-067d-4497-9289-4b9bb628f0aa(#1)는 AdMob 다운로드 ContentTooShortError(2,958,799/3,149,407바이트), run064ecfc0-bcbb-470a-8fe2-0348534a4b5b(#2)는 Firebase SDK checksum mismatch로 종료됐다. 두 run 모두 before-build human_exception을 통과한 뒤 post-clone에서 실패했다. Archive는 FAILED, 내부 TestFlight 사후 작업은 SKIPPED이며 before-deploy claim은 없다. 정상 제품 QA나 네이티브 검수를 통과한 것으로 처리하지 않는다.

2026-11-13T03:01Z 독립 provider 조회에서 정확한 source run 두 개가 FAILED이며 각 run/builds와 app/builds, app/buildUploads는 모두0건이다. 정확한 관계에서 얻은 로그 artifact는 #1 15950dc4-b8c3-486a-b68d-80c6d988c91b(1,305바이트, SHAe51a76d4ac7f7cb60c9d86ac1159a6e47bd4bf9825ab6af38daaf4325bd01346), #2 c30c3aaf-a93a-4b28-a324-d05ca8a2d88c(766바이트, SHA242eb3bc2ee5a2045916ef900d2f25cd9c0ff15e353f97c55a0c6a44545e6805)이며 ZIP CRC를 확인했다. 업로드·TestFlight VALID·내부 제공은 미완료다.

허용 native2회를 소진했으므로 workflow를 disabled로 다시 읽어 확인했고 이 grant를 회수한다. 기존 profile·certificate·secret·내부 그룹·테스터와 첫 승인/만료, 두 claim·실패 로그는 보존한다. 새 후보에 이전 성공·횟수를 옮기거나 태그를 재지정하지 않는다. 다운로드 복구는 별도 제품 수정 후보로 준비하며 추가 Apple 실행은 이 grant로 시작하지 않는다. Android0.1.0(1) internal/completed는 유지한다.

회수 후 registry 바이트 SHA-256은`fa78e88a115387e32fb206c124fec049fefb085794e09a51298963ca53fa77de`다. 두 before-build claim의 grantSha256은 회수 전 승인 바이트 b0899f3…를 가리키며, 원본은 승인 merge5bde089df9f1aadafda7843a1245c24cafb3f54b의 해당 grant와 NAS 원본에서 확인한다. 회수 후 바이트를 과거 실행의 승인 바이트로 대체하지 않는다.


## 승인된 v0.1.1 SDK 복구와 추가 두 실행

사용자가2026-11-13T03:56:19.371994Z에 “수정 후보로 iOS 최대 2회 추가 진행”을 명시했다. 원문·질문·최종 source와 범위는 apple-additional-candidate-approval.json 및 새 Release asset742212649(2086B/SHA55773ed14f5694add93f95c6454f60a30fbd58eafa6523737322001827a9d3b7)에 있다. 추가2회/이전2회포함총4회, accepted upload총1회다. C13 원래 승인 기록과 만료는 그대로 보존한다. 새 grant의 유효 시작만 추가 승인 관측03:56:19Z로 두고, 만료는 원래2026-11-19T15:35:59Z를 유지해 기간을 늘리지 않는다.

활성 승인 시점 grant는 betta-0-1-1-apple-sdk-download-recovery, SHA-256 b1ff3b8c80afe485d9be130f71f8e7c9a58ab53d87498a4e53da397207ef1038다. source 706e1130de7d123bac68193821bf301ed9ad336e, annotated v0.1.1/원장code2, 실제 sourceCI43359608916 attempt2의 Python42/headless58을 결속한다. Android 추가 실행은 없다. sourceCI attempt1 첫 실행 실패와 로컬 모델 리뷰2회 미완료도 보존하며 통과로 기록하지 않는다. 게임PR2/callerPR4/SDKfixPR5는 Ready 미병합이다.

기존 app6834215464/product644d867e-46ae-4b8f-a634-f139c00d9fb6/workflow686987D3-6AD2-4755-9679-4FDC3CAF966B와 profile/cert/internal group을 재사용한다. 실제 Console에서 다음 Cloud 번호3을 읽었고 변경하지 않았다. 새 source claim1/2는 실제 Cloud3/4에만 대응한다. 이전 FAILED #1/#2와 claims·회수·접수0을 보존한다.

단일 IOS ARCHIVE/BettaAtelier/INTERNAL_ONLY, exact manualTag v0.1.1, disabled를 실제 GET 확인했다. 7개 redacted_value와 internal group fe2b5b03-483c-4f0a-ba37-4cc1ec80452f도 서버에서 재확인했다. 동일 production App Attest profile dc049deb-da89-418f-8c08-af8d53b4e72c/SHA52f39ebfe8c37a61f7fa608cbe3adc31bc14c1caa5d54a176a8958608665ca02와 certificate SHA6eda0a7eefe7fa7c736644d5b6a71cf5907e70da827640817024afd5ed05acb3다.

구성 지문 217b40d1cbc19c9ce61a8a64ab6706bf7acb95df5c1601bca7dd7dd5582f552b, 제품 tree 233c30e067edb58039d3ad4a1b31f6af87c25c50982d0af2117fe8774da02c23, 새 evidence f89ccaf43b6f4ca9028867e254784b4409aea0baf54e46a28e53eaf3a4f12df8(asset742212510)를 고정한다. 원래10관측과 추가승인·Apple두실패·sourceCI실패·모델리뷰미완료를 합친14관측을 새 Release에서 byte/size/SHA로 다시 읽었다. normal v2는 두 phase 모두 THREE_UI_ROUNDS_REQUIRED다. clean detached source706의 두 source phase 검사만 통과했으며 실제 Cloud 작업트리 전체 감사나 제품 UX/성능/네이티브 검수 통과가 아니다.

독립 tuple 검토·로컬 모델 검토·중앙 CI와 등록 바이트 재확인을 마친 후 workflow를 켜고 tag reference042b7d78-8f70-4e0c-a024-359e1ac3540e로 한 번 시작한다. 기기·공개·가격/역할·새 유료 플랜은 포함하지 않는다. 추가2회/접수1회와 원래 만료를 유지하고 내부 제공 또는 허용범위 종료 후 grant를 회수한다.

## Cloud3의 동일 IPA upload-only 등록

코드PR349의 검토·CI 성공 및 merge 0ca7daaeacfa20694b8783578eb9ecff427e9cc9에 결속한다. 기존 SDK recovery grant는 회수됐고 Cloud workflow는 disabled다. source706e113/tagv0.1.1, 원래 만료와 추가 승인 시각, 14개 기존 관측을 유지하고 run3의 실제 post-hook 실패·정확한 export/IPA·수정 감사·NAS 관측1개를 더해15개다.

새 ID betta-0-1-1-existing-ipa-upload-only, bytes SHA-256 2a670fe3e3172b650304a8dbdcc751989f5db14041259f4eb5f7e8fbcbc5fb44다. reviewed 로컬 CLI에서 실제 Cloud3 export만 검사·전송하며 추가 native0회, 기존3/4회와 접수총1회 상한을 유지한다. 공개·외부 TestFlight·기기·재서명은 없다. code/schema의 IPA_RECOVERY 고정값 그대로이며 새 검증 정책·로직은 없다. 별도 독립 운영 tuple 검토 후 metadata registry를 등록한다. 제품 normal v2/Cloud post-hook/전체 Cloud 작업트리 감사는 통과로 바꾸지 않는다. VALID와 기존 internal group 제공은 이후 실제 readback으로 확인하고 이 grant도 회수한다.
