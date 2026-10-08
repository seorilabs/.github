# Agent Contribution Contract

이 문서는 Seorilabs org repo에 agent가 PR을 만들 때 필요한 최소 계약이다. Contributor agent와 Integrator agent가 같은 기준을 사용한다.

## Contributor Preflight

작업 시작 전 확인:

- default branch 최신 동기화
- 연결된 Issue 또는 Project item
- source-of-truth 문서
- scope와 acceptance criteria
- 사람의 승인 설계·정확한 버전·범위
- repo-local test/smoke command
- release, store, production 영향 여부

작업 시작 금지 조건:

- 설계 승인 전 코드 구현, 기획 승인 전 신규 app code/repo/store registration 생성
- 배포 승인 전 production submit/promote/public release
- 티켓 없이 장기 작업 시작
- source-of-truth와 충돌하는 scope 확대
- secret, credential, service account key를 client/repo에 추가

## 설계와 PR

구현 전에 [개발 워크플로우](development-workflow.md)의 사람 설계 승인을 확인한다. PR 본문은 [공통 템플릿](../../PULL_REQUEST_TEMPLATE.md)을 사용하고 설계·승인·조건·테스트·검수 기록을 연결한다. UI 독립 검수와 Copilot 코드 리뷰는 별도 단계다.

## Version Impact Rules

| Impact | Contributor action | Integrator action |
| --- | --- | --- |
| `none` | 테스트 또는 문서 근거를 남긴다. | merge readiness만 확인한다. |
| `patch` | regression test 또는 smoke evidence를 남긴다. | patch release 필요 여부를 판단한다. |
| `minor` | spec, release note 후보, QA plan을 갱신한다. | planning 승인 범위 안인지 확인한다. |
| `major` | migration, rollback, approval 상태를 명시한다. | 사람 승인 전 merge/release를 막는다. |

## Integrator Intake Checklist

들어온 PR을 수용하기 전 확인:

- 티켓 연결이 있다.
- Project item이 있고 `App/Repo`, `Owner`, `Approval`, `Verification`이 채워져 있다.
- PR scope가 티켓과 맞다.
- spec/version impact가 말이 된다.
- 검증 결과가 PR description 또는 CI에 있다.
- CI failure가 무시되지 않았다.
- `contracts/review-policy.yaml`에 따라 미해결 리뷰 thread가 없고 required check가 통과했다.
- release 영향이 있으면 deployment approval 전 배포하지 않는다.
- source-of-truth 문서가 실제 상태와 맞다.

## Rejection / Rework Reasons

PR을 닫거나 되돌리는 대신 먼저 다음 상태로 분류한다.

| Intake State | 의미 | 다음 액션 |
| --- | --- | --- |
| `Needs ticket` | 실행 티켓 없음 | issue/project item 생성 요청 |
| `Needs spec` | 기준 스펙 또는 doc 없음 | source-of-truth 업데이트 요청 |
| `Needs tests` | 검증 증거 없음 | local/CI/runtime evidence 요청 |
| `Needs split` | scope가 큼 | 작은 PR로 분리 요청 |
| `Blocked by approval` | 승인 gate 필요 | 사람 승인 대기 |
| `Ready for review` | 리뷰 가능 | reviewer/CI 진행 |
| `Accepted` | merge 준비 완료 | merge 또는 release queue |
| `Rejected` | 방향 불일치 또는 폐기 | 이유를 남기고 close |

## Evidence Standard

검증 증거는 짧아도 된다. 단, 재현 가능해야 한다.

좋은 예:

```text
pnpm test:core
pnpm check:architecture
Godot headless smoke: res://tests/test_runner.tscn
Playwright mobile viewport screenshot verified at 390x844
gh run view 123456 --log-failed
```

부족한 예:

```text
looks good
테스트는 못 돌림
아마 괜찮음
```

테스트를 돌릴 수 없으면 이유와 대체 검증을 적는다.
