# Cloud 3의 실제 App Store IPA로 내부 배포 복구

#324와 기존 C13 승인, 추가 후보 승인 범위의 실행 복구다. 게임 후보706e113/v0.1.1, 만료2026-11-19T15:35:59Z, 이전 실패와 총 native4회/접수1회 상한을 유지한다. Cloud3은 컴파일과 App Store export에 성공한 뒤 post-hook의 npm EUSAGE에서 실패했다. 실제 접수0이며 before-deploy claim은 없다. 추가 빌드를 쓰지 않고 원본 export만 재사용한다.

`betta-existing-ipa-recovery.mjs`는 별도 reviewed grant에서만 실행한다. 기존 Cloud grant를 회수하고 workflow를 disabled로 유지한다. 정상 Cloud consumer는 새 upload-only grant를 사용할 수 없다. 코드 수정 PR과 실제 grant 등록 PR을 분리한다. 코드가 바뀌면 reviewed verifier가 다른 바이트를 거절하므로 기존 grant를 조용히 바꾸지 않는다.

실행 순서는 최신 중앙 grant와 원문 승인 조회, 기존 grant의 회수 확인, 정확한 원본 checkout/설정/원장/CI/14개 기존 관측/추가 실패 관측 확인, normal v2 실패 유지, 실제 Apple product와 총3개 실패 run 및 postaction SKIPPED·접수0·workflow disabled 확인, 완료된 ARCHIVE action의 artifact 관계 확인, 원본 ZIP·IPA·실패 로그 해시 검사, 서명 앱 검사, 원자적 upload intent 및 이전 두 before-deploy 슬롯 fence 생성, 같은 IPA의 altool 업로드다. 실행 중인 Cloud 환경을 흉내 내지 않는다.

고정 원본은 App Store export50b289bc-ba5f-4b1e-b488-e2e0877354d9, 111239439B/SHA30ef369a…, IPA111349261B/SHA5ef31cb0…다. xcarchive와 development export를 대신 쓰지 않는다. log artifact e9779afd…의 정확한 원본에서 post-hook npm 오류를 다시 확인한다. 기존 before-build claim742264873의 원문 해시5eb5e964…를 확인한다. signed app은 원래 team/profile/cert, bundle/version/build3, 실제 code signature와 entitlements/privacy 검사를 모두 거친다. codesign의 인증서 출력 prefix는 `--extract-certificates=<prefix>` 한 인자로 전달해 파일 경로 오해를 고친다.

불명 접수·중복 슬롯·만료·회수·새 source/CI/실행·파일 변조·서명 차이에는 업로드하지 않는다. intent 생성 뒤 실패하면 자동 재시도하지 않고 실제 provider만 읽는다. 업로드 성공 뒤에도 VALID와 내부 그룹 제공을 별도로 확인한다. 기존 normal QA blocked/nativeQaWaived:false/publicReleaseAllowed:false, 실제 Cloud post-hook 실패와 full Cloud working-tree 감사 미실행을 보존한다. 새 게임 QA·기기·공개·외부 TestFlight·재서명·새 계정/비용은 없다.

기존 L1/dev test-plan을 따른다. 실제 CLI 인자 회귀, 실패 run·artifact 선택·시장 접수 차단, 동시 원자적 슬롯, 정확한 signed app 직접 감사와 관련 전체 Betta 회귀를 실행한다. 중앙 CI와 로컬 모델 리뷰, 독립 운영 검토 뒤에 grant를 등록한다. 최종 grant도 내부 제공 뒤 회수한다. 원본과 실패·성공 근거는 NAS에 파일별 size/SHA를 다시 읽어 보존한다.

업로더는 중앙에서 reviewed bytes를 확인하는 `recover-betta-existing-ipa.mjs` 로컬 CLI다. 새 CI 실행을 가장하지 않으며 보호된 CLI의 직접 실행 경로와 hash를 검사·기록한다. 소스의 producer는 기존 실제 Cloud3과 원자적 before-build claim이다. 업로드 직전 altool의 지원 환경 변수 API_PRIVATE_KEYS_DIR 아래 실제 등록 키 파일을 읽기 API용 키와 대조한다. 업로드 명령 전에는 intent/fence를 담은 preflight 영수증을, 명령 종료 뒤에는 별도 `.upload-result.json`을 각각 변경 불가능한 파일로 남긴다. 불명 접수는 자동 재시도하지 않는다.
