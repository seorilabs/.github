# 실행 티켓

- 이슈: https://github.com/seorilabs/.github/issues/286
- 승인: https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6265815627
- 범위: 같은 폴더의 design.md와 test-plan.json
- TDD: 허용 동작이 없는 전용 stub에서 정상 경로가 실패한 원본 red-tests.log를 보존했다. 구현 뒤 허용 단계, 거부 조건과 실제 정상 플랫폼 검증을 검사한다.
- 현재 실제 SDK 근거는 미실행이다. 실제 후보의 네이티브 문서는 정상 before-build L3 통과, before-release `platform-first rewarded-ads ios` 실패를 보존했다.
- 전체 중앙 테스트, package검사, 교차 리뷰와 CI 뒤에만 병합한다.
- 원본: `lizard-tycoon-ui190-evidence/app-store-191-submission-20261019/central/`
- 이 문서는 실제 SDK, 기기, 빌드나 심사 제출 통과 기록이 아니다.

## 구현 검증

- 전체 중앙 테스트 1,676개와 관련 129개가 통과했다. `npm run pack:check`, 새 workflow의 actionlint와 diff 공백 검사도 통과했다.
- 실제 GitHub Release 근거를 읽은 `before-build`가 승인 예외와 원래 실패 3개를 보존하며 통과했다. 첫 조회의 연결 오류는 원본 로그에 남겼다.
- CI의 읽기 전용 토큰 실행과 교차 리뷰는 PR에서 확인한다. 실제 SDK, Cloud 빌드와 심사 접수는 아직 미실행이다.
