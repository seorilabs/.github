# Spiritgate UI5의 별도 승인과 검증 결속

- 설계 ID: `SGD-UI5-TF-110-v1`; 사람 승인: [원문](approval.json), [승인된 정확한 제안](approved-proposal.md).
- 제품 제안 커밋: `62415abe96c65b05849e599294cd351e997b8020`; 제안 SHA-256: `79990dc322c4c5bbb29232b35a209219e99d56af60f52ad517eb99200fa4cb10`.
- 실행 티켓: [전체 출시 #240](https://github.com/seorilabs/spiritgate-defenders/issues/240); 제품 후보 검수와 중앙 검증기 구현을 구분한다.

## 문제와 동작

기존 첫 내부 TestFlight 검증기는 독립 UI 기록 4개만 받는다. 실제 환경 차단으로 끝난 UI4를 보존하고 사람에게 승인받은 UI5까지 담으면 거절된다. grant의 `approvedUiRounds`를 4 또는5로 제한하고 실제 기록 수와 정확히 비교한다. 생략한 기존 필드는 기존4회 의미를 유지한다. 5회는 별도 승인 파일과 SHA-256, 정확한 제안 bytes, 동일 후보·설정·원래 시점 예외 승인 hash가 있어야 한다.

기존 UI4의 승인 시각·상한을 바꾸지 않도록 과도기 v1 Editor 근거에는 선택적인 `additionalIterationApprovals` 배열을 추가한다. 각 추가 회차는 자신의 계획 전에 내려진 사람 승인으로 검증한다. 기존 단일 `additionalIterationApproval`은 계속 지원한다. UI5의 별도 승인은 실제 새 원문 시각과 중앙 reviewed grant의 hash로 추가 결속한다.

## 범위·검증·운영

- 마지막 실제 회차/전체 Editor E2E/Android 실제 기반 검수는 계속 필수다. UI1~4 failed/partial/blocked 원문과 해결 링크를 보존한다.
- 5회만 추가하며 무제한 >=4, UI6, 최초168시간 기한 연장은 허용하지 않는다. 본180분과 문제 재확인1회30분/전체210분을 승인 원문과 결속하고 마지막 회차 전체210분을 검사한다. 본/재확인 구간은 실제 회차 보고서에서 별도 검토한다.
- 첫 내부 한 후보·한 빌드·한 업로드·INTERNAL_ONLY·기존 프로덕션 profile/서명·실제 iPhone 설치 후 검수·정상 공개 검증을 유지한다.
- TDD: 승인된5회가 실패하는 RED, 원문/hash/후보/설정/시각/회차 수/시간 상한/Android 및 공개 경계 거절 검사, 전체 중앙 테스트와 패키징 검사.
- 이 PR은 검증기 지원만 구현한다. grantRegistry는 빈 상태이며, 승인 파일의 후보·설정은 실제 근거가 확정된 reviewed 등록에서 채운다. 실행·업로드·공개를 활성화하지 않는다.
- Claude 읽기 전용 제한 코드 diff 전송은 승인 범위로만 진행하고 모든 도구를 끈다. 자동 Copilot을 포함해 전체2회 상한을 유지한다. 자격증명·PixelLab 원본·개인정보·실행 로그를 제외한다.
- 롤백은 미등록 상태의 검증기 PR을 되돌리는 별도 PR이다. 기존4회 계약의 판단과 승인 시각은 수정하지 않는다.

## 실행 중 중앙 정책 갱신

중앙3a2c19a는 등급제 v2를 도입했으며 이미 승인된 v1 설계는2026-10-22T00:00:00Z까지 v1 근거로 마칠 수 있다. 새 검증기/schema는 그대로 유지하고, UI5 승인 목록 보정은 `development-evidence-v1.mjs`와 v1 schema에만 적용한다. 승인된 실제 검수·기존168시간 시점 예외·iPhone 확인·정상 공개 검증 범위를 낮추지 않는다. 새 의존 verifier 파일도 기존 reviewed-source bytes 검사에 포함한다.
