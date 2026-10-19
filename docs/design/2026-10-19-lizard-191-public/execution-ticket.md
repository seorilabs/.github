# 실행 티켓

- 이슈: https://github.com/seorilabs/.github/issues/283
- 승인: https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549
- 범위: design.md와 test-plan.json. 일반 근거 validator와 1.9.0 grant는 유지한다.
- 테스트 우선 근거: 전용 분기가 disabled인 red에서 허용 경로3개가 실패했고 구현 뒤 관련29개와 전체1659개가 통과했다.
- 실제 근거 CLI: draft development-evidence의 후보별 자산을 읽어 before-build human_exception을 반환했다. 원래 세 오류와 실패 판정은 출력에 남는다.
- 원본: `lizard-tycoon-ui190-evidence/android-191-public-20261019/`의 red-tests.log, central-full-tests.log, continuation-before-build.log.
- 교차 리뷰와 PR CI 후에만 중앙 main에 반영한다. 같은 후보 외 배포와 신규 기기 실행은 하지 않는다.

## 후속 실제 결과

일반 v1.9.1 Release의 원본 ZIP 결속과 rollout=1 제한, 다른 마켓 경로 보존을 교차 리뷰로 수정했다. 최종 전체1667개와 실제 CI의 읽기 전용 토큰 before-build, before-deploy, before-release가 통과했다. 승인 예외와 원래 세 오류는 출력에 함께 보존했다. 업로드39231170518과 승격39233393720은 같은 제품 SHA와 versionCode1001004042를 사용했다. 공개 뒤 정리는 [후속 설계](../2026-10-19-lizard-191-retire/design.md)를 따른다.
