# 실행 티켓

- 이슈: https://github.com/seorilabs/.github/issues/283
- 승인: https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549
- 범위: design.md와 test-plan.json. 일반 근거 validator와 1.9.0 grant는 유지한다.
- 테스트 우선 근거: 전용 분기가 disabled인 red에서 허용 경로3개가 실패했고 구현 뒤 관련29개와 전체1659개가 통과했다.
- 실제 근거 CLI: draft development-evidence의 후보별 자산을 읽어 before-build human_exception을 반환했다. 원래 세 오류와 실패 판정은 출력에 남는다.
- 원본: `lizard-tycoon-ui190-evidence/android-191-public-20261019/`의 red-tests.log, central-full-tests.log, continuation-before-build.log.
- 교차 리뷰와 PR CI 후에만 중앙 main에 반영한다. 같은 후보 외 배포와 신규 기기 실행은 하지 않는다.
