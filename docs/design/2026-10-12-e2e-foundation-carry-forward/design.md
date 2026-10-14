# 영향 없는 기반 기능의 검수 이어받기

- 설계 ID·버전: `2026-10-12-e2e-foundation-carry-forward`, v1
- 상태: 승인된 대화 범위의 실행 명세. [2026-10-14 변경 등급별 테스트 계획](../2026-10-14-test-levels/design.md) 이후 L3 회귀 범위 안에서 유지
- 승인 근거: 2026-10-12 대화의 “결제 관련한 기능 변경이 없으면 생략하자. 주요 기반 기능 중에 영향이 없는 것들은 테스트에서 스킵하자.” 및 선택 확인(경로 자동 판정, 기반 기능만, 30일, 실기기 후보당 1회).
- 원본: 이 문서의 최초 커밋. 연결 티켓·PR은 PR 본문에 기록한다.

## 문제

UI 검수 3회는 회차마다 `core` 기능 전체를, 최종 E2E는 구현 기능 전체를 요구한다. 결제·광고처럼 실기기에서만 확인되는 기능이 매 회차·매 후보마다 다시 실행되어 결제 코드를 건드리지 않은 변경도 전체 검수가 느려진다.

## 결정

```text
기능 목록의 기반 기능(foundation: true, paths)
        │
        ▼
기준 SHA(실제로 통과한 실행) ──비교──▶ 후보 SHA
        │
        ├─ 바뀐 파일 ∩ paths = 없음, 기능 정의 동일, 실제 실행 30일 이내 → 이어받기(생략)
        └─ 겹침 · 비교 불가(조상 아님·300개 이상) · 정의 변경 · 30일 초과 → 다시 실행
```

| 항목 | 규칙 |
|---|---|
| 생략 대상 | 소스 `docs/qa/feature-inventory.json`에 `foundation: true`와 `paths`(glob)를 적은 기반 기능만. 결제·광고·로그인·클라우드 저장·원격 설정·분석·권한 등. 제품 기능은 지금처럼 전체 검수 |
| 영향 판정 | 검증기가 기준 SHA부터 후보 SHA까지 바뀐 파일(이름 변경 전후 포함)을 `paths`와 비교한다. 에이전트 판단으로 생략하지 않는다 |
| 판정 불가 | 기준이 후보의 조상이 아니거나 비교 결과가 300개 이상이면 영향 있음으로 본다 |
| 기능 정의 | 기준 SHA의 같은 기능 `foundation`·`paths`와 다르면 다시 실행한다 |
| 기간 | 실제로 실행한 시각부터 30일. 이어받은 근거를 다시 이어받아도 기준 SHA·실행 시각은 원래 실행 값을 유지한다 |
| 적용 단계 | UI 검수 각 회차의 `core` 요구 목록과 최종 E2E의 전체 기능 요구 목록에서 이어받은 기능을 뺀다 |
| 실기기 | 영향받은 기반 기능은 1·2회차에 개발 런타임의 테스트용 대체 구현으로 확인하고, 실기기 확인은 후보마다 1회(3회차 또는 최종 E2E) 한다. 그 뒤 변경이 경로를 건드리지 않으면 최종 E2E에서 그 실기기 실행을 이어받는다 |
| 유지 | 같은 후보 E2E 168시간 재사용, 설정 지문, 미실행·차단은 통과 아님, 마켓별 근거 분리 |

`paths`에는 기능의 코드·화면뿐 아니라 그 기능의 SDK 버전이 바뀌는 의존성·네이티브 빌드 설정 파일을 함께 적는다. 빠뜨리면 SDK 갱신이 이어받기로 통과하므로 기능 목록 변경을 리뷰한다.

## 인터페이스

기능 목록(소스, `schemaVersion: 1` 유지, 필드 추가):

```json
{ "id": "premium-iap-purchase", "core": false, "foundation": true,
  "paths": ["src/adapters/purchase/**", "scenes/shop/**", "android/app/build.gradle"] }
```

검수 근거(`schemaVersion: 1` 유지, 선택 필드 추가):

```json
"carriedForward": [
  { "featureId": "premium-iap-purchase", "baselineSha": "<실제 실행 SHA>",
    "verifiedAt": "2026-10-01T03:00:00Z", "evidence": ["<그 실행의 근거 URL>"] }
]
```

검증기 오류: `CARRY_FORWARD_NOT_FOUNDATION`, `CARRY_FORWARD_EXPIRED`, `CARRY_FORWARD_DIFF_UNAVAILABLE`, `CARRY_FORWARD_INVENTORY_CHANGED`, `CARRY_FORWARD_AFFECTED`, `DUPLICATE carried-forward`. Release 검증은 GitHub compare·contents API, 로컬 `--file` 검증은 현재 저장소의 git으로 같은 정보를 읽는다.

## 인수조건과 검증

- AC-1: 경로가 겹치지 않는 기반 기능은 UI 회차·최종 E2E 목록에서 빠져도 통과한다.
- AC-2: 경로가 겹치거나, 비교할 수 없거나, 기능 정의가 바뀌었거나, 30일이 지났거나, 기반 기능이 아니면 실패한다.
- AC-3: 기존 근거(`carriedForward` 없음)는 이전과 같이 판정한다.
- AC-4: Release 검증과 로컬 CLI 검증이 같은 기준으로 동작한다.
- AC-5: 중앙 계약·실행 문서·템플릿과 `~/.agent` 지침이 같은 규칙을 말한다.
- 검증: 테스트를 먼저 바꿔 기존 검증기에서 실패를 확인한 뒤 `npm test`, `npm run pack:check`, `git diff --check`, 로컬 `scripts/validate.sh`를 실행한다.
- 제품 UI·빌드·마켓 변경이 없어 UI 3회 검수와 제품 E2E는 해당 없음. 각 앱의 기능 목록에 `foundation`·`paths`를 채우는 작업은 이 범위가 아니며, 채우기 전에는 지금처럼 전체를 검수한다.

## 적용과 복구

검증기는 중앙 checkout 최신본을 사용하므로 병합 즉시 모든 마켓 workflow에 적용된다. 기존 근거는 그대로 통과한다. 문제가 생기면 이 정책 커밋을 되돌리는 PR로 복구하며, 되돌린 뒤 `carriedForward`를 쓴 근거는 기능 누락으로 실패하므로 전체 검수로 돌아간다.
