# UI10 검증기 구현 티켓

- Refs https://github.com/seorilabs/spiritgate-defenders/issues/240 ; 후속 제거 https://github.com/seorilabs/.github/issues/249
- 범위/인수조건: design.md의 AC-10-1~4 전체, approved-proposal.md와 실제 사전 승인 receipt.
- 검증: test-plan.json의 중앙 L1/dev 합성 validator; 제품 L3/28·168/기기/별도 E2E와 구분.
- TDD: 기존 validator는10회 입력을 TESTFLIGHT_BOOTSTRAP_REQUIRED로 거절(RED). 신규 승인·typed 만료9 이력 결속 후 같은 입력 GREEN, 잘못된 시간/누락/해시/source/인계/종료/PASS 소급은 negative 검사.
- 출시: 중앙 Ready PR·CODE3 읽기 전용 리뷰(자동 포함2회)·필수 검사 후 squash merge. 제품 실제 grant/태그/번호/Cloud는 변경0.
