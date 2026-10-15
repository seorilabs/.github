# 정상 v2의 회차별 추가 승인을 원문대로 보존한다

- 실행 티켓: [Spiritgate #240](https://github.com/seorilabs/spiritgate-defenders/issues/240).
- 승인: [사람 승인 원문](approval.json), `2026-10-15T10:01:24.112573+00:00`. [설계](design.md) eca0a077·[계획](test-plan.json) 2f06b937·[범위](test-scope.md) 40595d37을 byte 그대로 고정한다. 설계의 미승인 표기는 승인 전 작성된 원문 상태를 보존한 것이며 실제 승인은 이 별도 기록을 따른다.
- 중앙 L1/dev와 service/public은 도구 계약의 PR 반영 범위다. 실제 제품 UI/실기기/E2E를 뜻하지 않는다.
- 인수조건: 기존 single nullable 필수형과 유효 single 입력을 유지한다. optional plural은 single:null, 비어 있지 않은 기존 Approval 객체 배열이며 같은 maxRound 중복·상충을 거절한다. 순서에 의존하지 않고 각 회차의 기존 maxRound≥번호·승인≤계획 조건을 유지한다.
- TDD: 정상4–7 별도 승인 fixture의 schema 실패 RED → 최소 schema/verifier 보정 GREEN → 잘못된 모드/중복/원소/시각·누락/한도·기존 실패/순서/L3/168시간/스코프 및 기존 v1/bootstrap 회귀.
- 변경은 승인 설계의4개 파일과 이 설계/승인 기록만이다. 제품·워크플로·서명·키/IAM·v1/bootstrap·grant registry·원래 기한/예산·한 빌드 제한 변경0.
- 최종 코드diff3개 파일만 도구 없는 Claude 읽기 전용 리뷰로 보낸다. 자동 Copilot 포함 요청 최대2회이며 개인 승인 문구/실행 로그/비밀/PixelLab 원본은 제외한다.
