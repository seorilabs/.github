# 설계 목록

본문 정본은 이 디렉터리다. Wiki에는 날짜·승인 순서별 요약과 아래 원본·티켓·PR·검수 링크를 연결한다.

| 날짜 | 설계·상태 | 승인 버전 | 티켓·PR | 검증 |
|---|---|---|---|---|
| 2026-10-08 | [개발 워크플로우 — 사람 승인](2026-10-08-development-workflow/design.md) | [승인 기록 커밋 c574677](https://github.com/seorilabs/.github/blob/c574677e953b5f7def57b9ee2b9d25a95c090e3b/docs/design/2026-10-08-development-workflow/design.md) | [실행 티켓 218](https://github.com/seorilabs/.github/issues/218) · [적용 PR 219](https://github.com/seorilabs/.github/pull/219) · [공통 설치 티켓 38](https://github.com/magicsih/agent-config/issues/38) | [PR 검증 결과](https://github.com/seorilabs/.github/pull/219/checks) |
| 2026-10-12 | [리뷰 기본값과 저장소 예외 v1](2026-10-12-review-policy-lite/design.md) | [대화 승인 범위 기록 7ee22bd](https://github.com/seorilabs/.github/blob/7ee22bd/docs/design/2026-10-12-review-policy-lite/design.md) | [중앙 티켓 231](https://github.com/seorilabs/.github/issues/231) · [로컬 티켓 54](https://github.com/magicsih/agent-config/issues/54) | 각 PR의 계약·스킬 검증 결과 |
| 2026-10-12 | [영향 없는 기반 기능의 검수 이어받기 v1](2026-10-12-e2e-foundation-carry-forward/design.md) | 대화 승인 범위 기록(이 설계의 최초 커밋) | PR 본문에 기록 | 각 PR의 계약·검증기 테스트 결과 |
| 2026-10-13 | [Reascend 1.1.0 사람 승인 출시 예외](2026-10-13-reascend-release-exception/design.md) — 대체됨(등급제 적용 때 장치 삭제) | [승인 receipt](https://github.com/seorilabs/.github/blob/0963a4ed06d9129f633fc554d1b5de49a7600714/contracts/release-exceptions/reascend-1.1.0.approval.json) | [Reascend 506](https://github.com/seorilabs/reascend/issues/506) | 중앙 예외·회귀 검사; 제품 전체 E2E blocked 보존 |
| 2026-10-13 | [Match Symbols iOS 1.1.7 실기기 검수 예외 v1 — 사람 승인](2026-10-13-match-picture-ios-117-exception/design.md) — 대체됨(등급제 적용 때 장치 삭제) | [783b0e9 승인 receipt](https://github.com/seorilabs/.github/blob/0963a4ed06d9129f633fc554d1b5de49a7600714/contracts/release-exceptions/match-picture-1.1.7.approval.json) | [앱 PR 113](https://github.com/seorilabs/match-picture-app/pull/113) · [제품 티켓 112](https://github.com/seorilabs/match-picture-app/issues/112) | [중앙 PR 241](https://github.com/seorilabs/.github/pull/241) · [실행 티켓 242](https://github.com/seorilabs/.github/issues/242); 실제 검수 판정 보존 |
| 2026-10-14 | [변경 등급별 테스트 계획과 앞단 승인 v1 — 사람 승인](2026-10-14-test-levels/design.md) | 대화 승인(검토용 커밋 7c117d4, 승인 기록은 문서 안) | PR 본문에 기록 | 중앙 검증기·계약 테스트 결과 |

설계 최신 원본과 승인 커밋을 구분한다. 기존 승인 문서를 임의로 이동하거나 본문을 복제하지 않는다.

| 2026-10-14 | [Spiritgate UI5 별도 승인 결속](2026-10-14-spiritgate-ui5/design.md) | [원문 승인](2026-10-14-spiritgate-ui5/approval.json) · 제품 제안62415abe | [Spiritgate240](https://github.com/seorilabs/spiritgate-defenders/issues/240) | 중앙 거절 검사·전체 회귀; 실제 제품 UI5는 독립 실행 |

| 2026-10-15 | [Spiritgate UI6 별도 승인과 과거 snapshot 결속](2026-10-15-spiritgate-ui6/design.md) | [원문 승인](2026-10-15-spiritgate-ui6/approval.json) · 제안08fe7332 | [Spiritgate240](https://github.com/seorilabs/spiritgate-defenders/issues/240) · [중앙 실행 범위](2026-10-15-spiritgate-ui6/execution-ticket.md) | 중앙 TDD·회귀; 실제 제품 실행과 구분 |

| 2026-10-15 | [Spiritgate UI7과 UI6 원본 실패 결속](2026-10-15-spiritgate-ui7/design.md) | [원문 승인](2026-10-15-spiritgate-ui7/human-approval.json) · 제안7d912748 | [Spiritgate240](https://github.com/seorilabs/spiritgate-defenders/issues/240) · [중앙 실행 범위](2026-10-15-spiritgate-ui7/execution-ticket.md) | 중앙 TDD·회귀; 실제 UI7 별도 |

| 2026-10-15 | [정상 v2 추가 UI 승인 체인](2026-10-15-normal-v2-ui-approval-chain/design.md) | [사람 승인](2026-10-15-normal-v2-ui-approval-chain/approval.json) · 설계eca0a077 | [Spiritgate240](https://github.com/seorilabs/spiritgate-defenders/issues/240) · [실행 범위](2026-10-15-normal-v2-ui-approval-chain/execution-ticket.md) | 중앙 L1/dev; 제품 QA와 구분 |

| 2026-10-21 | [로컬 모델 코드 리뷰로 봇 리뷰 대체 v1 — 사람 승인](2026-10-21-local-model-review/design.md) | 대화 승인(승인 기록은 문서 안) | PR 본문에 기록 | 계약 테스트·리뷰 스크립트 실측 |

| 2026-10-16 | [Godot headless E2E 기본 검수와 실기기 범위 축소 v1 — 사람 승인](2026-10-16-godot-headless-e2e/design.md) | 대화 승인(검토용 커밋 f6f07f0 = 408faef와 같은 bytes, 승인 기록은 문서 안) | PR 본문에 기록 | 중앙 검증기·계약 테스트 결과 |

| 2026-10-16 | [Spiritgate 실패 Cloud12 보존과13 단일 복구](2026-10-16-spiritgate-cloud12-recovery/design.md) | [직접 승인](2026-10-16-spiritgate-cloud12-recovery/approval.json) · 제안b1da2d71 | [Spiritgate240](https://github.com/seorilabs/spiritgate-defenders/issues/240) · [실행 티켓](2026-10-16-spiritgate-cloud12-recovery/ticket.md) | [중앙 L1 실행](2026-10-16-spiritgate-cloud12-recovery/execution.md); 실제 Cloud/기기 검수 별도 |

| 2026-10-23 | [배포 없는 테스트 계획 v1](2026-10-23-no-release-plans/design.md) | 대화 승인, 설계 7701faa | [중앙 티켓 305](https://github.com/seorilabs/.github/issues/305) | 중앙 계약, 검증기와 CLI 테스트 |
