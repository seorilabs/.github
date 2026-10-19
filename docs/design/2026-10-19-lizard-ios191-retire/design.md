# App Store 1.9.1 제출 후 전용 연결 제거

[승인된 사용자 실행 대체 제안](../2026-10-19-lizard-ios191-owner/design.md)의 종료 조건을 실행한다. 실제 App Store1.9.1(56)은 2026-10-19T14:37:34.155Z 접수됐다. 제출 ID `bbd29612-42bf-411a-bf2b-d0761471ba34`, 버전과 제출 상태는 모두 `WAITING_FOR_REVIEW`이며 항목은 원래 초안 하나, 연결 빌드는56이다. `AFTER_APPROVAL`을 유지했다. 승인 또는 공개 완료는 아니다. 실제 결과는 [앱 이슈805](https://github.com/seorilabs/lizard-tycoon/issues/805)에 남긴다.

전용 iOS grant와 등록, 코드 및 테스트, 공용 CLI의 submission-build-id 및 submission-artifact-sha256 입력, 중앙 읽기 전용 workflow를 제거한다. 앱 caller는 앱의 결과 기록 PR에서 제거한다. 일반 검증과1.9.0 내부 업로드 한정 grant는 유지한다.

전체 npm test, actionlint 및 diff 검사를 수행하고 Claude 읽기 전용 교차 리뷰 및 CI를 거친다. 과거 envelope와 두 전용 CLI 입력이 더 이상 허용되지 않는지 검사한다. 원본 사용자 승인, 실제 CI 및 정상 native 실패, Simulator 차단, 서버 근거와 시간 한계는 바꾸지 않고24c559f 및 앱 docs와 릴리스 자산에 보존한다. 새 기기 또는 제품 실행은 하지 않는다.
