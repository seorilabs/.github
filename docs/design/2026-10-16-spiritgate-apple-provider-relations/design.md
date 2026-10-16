# 첫 내부 Apple 관계 조회 보정

상태: 사용자 승인 후 구현/검증 중. 정확한 범위는 [승인 제안](approved-proposal.md), [승인](approval.json), [테스트 계획](test-plan.json)을 따른다.

실제 Apple 기본 GET 응답은 관계 data를 생략하므로 product/app, workflow/product 및 run/workflow·product·sourceBranchOrTag를 include로 명시한다. 기존 실제 provider 검증 조건은 그대로 유지하며, 같은 HTTP 경로의 합성 회귀로 누락 관계를 계속 거절하는지 확인한다.

제품/사용자 흐름·grant·실패 이력·한 Cloud·원래 기한·서명·iPhone/공개 v2·L3·E2E 조건은 바꾸지 않는다. 테스트 코드가 메모리에서 생성한 합성 키만 사용하며 실제 credential/응답/로그는 리뷰에 보내지 않는다. 이전 제안 원본과 RED/GREEN의 임시 실행은 제품·Cloud 실행 근거가 아니다.
