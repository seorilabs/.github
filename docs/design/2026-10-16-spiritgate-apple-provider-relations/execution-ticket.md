# 실행 티켓

- 사용자 직접 승인: 두 파일 최소 보정·제한 리뷰·검사 후 병합 승인.
- 이슈: seorilabs/spiritgate-defenders#240, #249의 첫 내부 TestFlight 차단 해소.
- 인수조건: include 없는 실제 API 모양에서 RED, 조회 옵션 추가 후 GREEN; 필수 관계5개 누락 거절; 전체 중앙 검사/pack/actionlint/diff/CI; 코드2파일 제한 Claude·자동 Copilot 포함 총2회; 지적 답변·미해결0 뒤 squash merge.
- 실제 Cloud는 fresh reviewed main·다음12·INTERNAL_ONLY·run0·불변태그·기한 확인 후 단1회. 정상 공개/실기기/E2E 조건은 그대로 남는다.
