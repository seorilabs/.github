# 설계 목록

본문 정본은 이 디렉터리다. Wiki에는 날짜·승인 순서별 요약과 아래 원본·티켓·PR·검수 링크를 연결한다.

| 날짜 | 설계·상태 | 승인 버전 | 티켓·PR | 검증 |
|---|---|---|---|---|
| 2026-10-08 | [개발 워크플로우 — 사람 승인](2026-10-08-development-workflow/design.md) | [승인 기록 커밋 c574677](https://github.com/seorilabs/.github/blob/c574677e953b5f7def57b9ee2b9d25a95c090e3b/docs/design/2026-10-08-development-workflow/design.md) | [실행 티켓 218](https://github.com/seorilabs/.github/issues/218) · [적용 PR 219](https://github.com/seorilabs/.github/pull/219) · [공통 설치 티켓 38](https://github.com/magicsih/agent-config/issues/38) | [PR 검증 결과](https://github.com/seorilabs/.github/pull/219/checks) |
| 2026-10-12 | [리뷰 기본값과 저장소 예외 v1](2026-10-12-review-policy-lite/design.md) | [대화 승인 범위 기록 7ee22bd](https://github.com/seorilabs/.github/blob/7ee22bd/docs/design/2026-10-12-review-policy-lite/design.md) | [중앙 티켓 231](https://github.com/seorilabs/.github/issues/231) · [로컬 티켓 54](https://github.com/magicsih/agent-config/issues/54) | 각 PR의 계약·스킬 검증 결과 |
| 2026-10-12 | [영향 없는 기반 기능의 검수 이어받기 v1](2026-10-12-e2e-foundation-carry-forward/design.md) | 대화 승인 범위 기록(이 설계의 최초 커밋) | PR 본문에 기록 | 각 PR의 계약·검증기 테스트 결과 |
| 2026-10-13 | [Reascend 1.1.0 사람 승인 출시 예외](2026-10-13-reascend-release-exception/design.md) | [승인 receipt](../../contracts/release-exceptions/reascend-1.1.0.approval.json) | [Reascend 506](https://github.com/seorilabs/reascend/issues/506) | 중앙 예외·회귀 검사; 제품 전체 E2E blocked 보존 |
| 2026-10-13 | [Match Symbols iOS 1.1.7 실기기 검수 예외 v1 — 사람 승인](2026-10-13-match-picture-ios-117-exception/design.md) | [783b0e9 승인 receipt](../../contracts/release-exceptions/match-picture-1.1.7.approval.json) | [앱 PR 113](https://github.com/seorilabs/match-picture-app/pull/113) · [제품 티켓 112](https://github.com/seorilabs/match-picture-app/issues/112) | [중앙 PR 241](https://github.com/seorilabs/.github/pull/241) · [실행 티켓 242](https://github.com/seorilabs/.github/issues/242); 실제 검수 판정 보존 |

설계 최신 원본과 승인 커밋을 구분한다. 기존 승인 문서를 임의로 이동하거나 본문을 복제하지 않는다.
