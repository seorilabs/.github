# 승인된 UI8 중앙 최소 보정을 실행한다

- 티켓: [Spiritgate #240](https://github.com/seorilabs/spiritgate-defenders/issues/240), v1 은퇴 [중앙 #249](https://github.com/seorilabs/.github/issues/249).
- 정본: [설계](design.md), [정확한 제안](approved-proposal.md), [사람 승인 원문](human-approval.json), [승인 결속](approval.json), [L1/dev 계획](test-plan.json).
- 인수조건: AC-8-1~4 전체. UI7 원래/수정 source, 실패·미완료, 두 clock, 실제 종료, 이전4~6회/승인/예산/만료를 보존한다.
- TDD: 기존 schema의 신규8회 합성 정상 입력 거절을 RED로 보존하고, 최소 schema/verifier/회귀 검사 후 GREEN으로 확인한다. 순수 fixture는 실제 제품 검수가 아니다.
- 실제 UI8/E2E/Android 통과·등록·번호·태그·빌드는 만들지 않는다. registry는 빈 배열로 유지한다.
- 최종 코드 diff만 제한 Claude 리뷰, 자동 Copilot 포함 총2회, 필수 검사와 미해결 thread0 및 최신 HEAD를 확인해 병합한다.
