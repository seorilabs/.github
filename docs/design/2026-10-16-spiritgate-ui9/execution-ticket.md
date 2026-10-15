# UI9 승인·입력 인계와 UI8 실패 원본 결속

- 티켓: https://github.com/seorilabs/spiritgate-defenders/issues/240
- 후속 제거: https://github.com/seorilabs/.github/issues/249
- 설계/인수조건: [design.md](design.md)의 AC-9-1~4 전체.
- 승인: [implementation-approval.json](implementation-approval.json); CODE 변경은 승인된 a226b0c patch의3파일.
- 검사: [test-plan.json](test-plan.json)의 중앙 L1/dev 합성 validator 검사, 기존4–8/정상v2/provider/서명 회귀, 전체 npm test·pack·actionlint·diff.
- TDD: 기존 validator의9회 거절 RED, human-only 조건의 후속 agent 인계 거절 RED → 최소 구현 GREEN. 실제 제품 실행/기기 PASS는 생성하지 않는다.
- 운영: Ready 한국어 PR·제한 CODE 리뷰·지적 처리·필수검사 후 squash merge. 실제 UI9는 만료/미완료이며 재개하지 않는다. registry[]·실제 grant·tag·번호·Cloud0을 유지한다.
