# 계약 검증 실행 기록

[Issue296](https://github.com/seorilabs/.github/issues/296)의 CH-01~04를 L1 개발 환경에서 검증했다. 승인 범위와 테스트 계획을 e78b785에 먼저 기록했고, 기준은 중앙 main 17005d45dcb358b666d91ea9a2ec30a2c79b1e9a다. 테스트 입력은 합성 기록이며 앱의 실제 UI 검수나 실기기 실행이 아니다.

- Red: 과거 완전4회와 새 후보5~7회 입력이 기존 schema에서 `EVIDENCE_SCHEMA /reviewHistoryRecovery: additionalProperties`로 거절되는 요구사항 실패를 먼저 확인했다.
- Green: `node --test tests/completed-review-history.test.mjs tests/review-history-recovery.test.mjs` 66개 통과. 과거 완전 회차는 합격 수0회이며, 원래 구현자와 검수자, SHA와 시각, 원본 식별 해시, 당시 추가 승인 및 실제 번호 상한을 검사한다. 두 새 회차만 실행, 순번 변경, 과거 승인 삭제와 소급 승인, 범위 누락, 후보 및 독립성, 시간 순서와168시간 위반을 차단한다.
- 전체: `npm test` 1,696개 통과. 기존 정상 v2와 복구 입력, v1, CI 확인과 플랫폼 하한 검사를 함께 실행했다.
- 산출물 및 정적 검사: `npm run pack:check`, `actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml`, `git diff --check` 통과.

과거 기능 목록에는 새 기능을 소급 요구하지 않으며 새 세 회차의 기능과 UX는 현재 전체 목록을 덮어야 한다. 과거 실패 판정은 해결 근거와 함께 그대로 남는다. 두 번 이상의 완전한 과거 회차도 원래 승인 상한과 연속 시간 순서를 검사한다.

로컬 모델 리뷰와 원격 PR CI 및 병합 결과는 PR 실행 원장에 기록한다. 이 계약 검증으로 제품 UI5~7, 네이티브 SDK, AAB, 마켓 업로드 또는 공개가 통과했다고 주장하지 않는다.
