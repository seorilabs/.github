# 승인된 UI6 한 회차를 과거 검수와 구분해 검증한다

- 원장 티켓: [Spiritgate #240](https://github.com/seorilabs/spiritgate-defenders/issues/240).
- 설계·승인: [설계](design.md), [원문 승인](approval.json), [정확한 제안](approved-proposal.md), [중앙 L1/dev 계획](test-plan.json). 이 디렉터리의 최초 문서 커밋이 승인 범위 기록이다.
- 인수조건: 설계 AC-6-1~4를 모두 유지한다. UI5 원문 소급 변경·UI7·기한 연장·실기기 면제·registry 활성화는 포함하지 않는다.
- 구현: 중앙 schema/검증기·의미 있는 허용/거절 테스트만 변경한다. 실제 제품 UI6·Android/iPhone·E2E는 이 티켓의 테스트 fixture로 대체하지 않는다.
- 실행 결과: RED/GREEN·전체 중앙 회귀·pack:check·diff 결과를 PR에 기록한다. PR/CI/리뷰/병합과 제품 빌드/업로드/검수/공개를 구분한다.
