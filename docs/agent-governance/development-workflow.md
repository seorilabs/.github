# 개발 워크플로우

정본은 [development-workflow.yaml](../../contracts/development-workflow.yaml)이다. [승인 설계](../design/2026-10-08-development-workflow/design.md)는 결정 근거이며 이 문서가 실행 절차다. 공통 정책을 앱별 문서·스킬에 복제하지 않는다.

## 작업 정리와 설계 승인

`/plan`은 에이전트가 전체 작업·순서·의존성·영향 레포·미확정 사항·승인과 실행 자원을 정리하는 단계다. 구현 승인이나 상세 설계를 대신하지 않는다.

구현할 작업은 레포 `docs/design/YYYY-MM-DD-short-name/design.md`에 [설계 템플릿](templates/design.md)으로 작성한다. 흐름·구조·화면 예시를 우선하고, 목적·범위·근거, 사용자 흐름·상태, 책임·의존성, 데이터·인터페이스·실패, 품질, 대안·결정, 인수조건·테스트, 적용·운영·복구, 승인·추적을 포함한다. 작은 변경은 한 페이지로 축약하고 해당 없음은 이유를 기록한다.

같은 폴더의 `test-plan.json`에 [테스트 등급과 출시 범위](#테스트-등급과-계획)를 적어 설계와 함께 승인받는다. 사람 확인은 이 앞단에 모으고 착수 뒤에는 [정지 조건](#승인-뒤-진행과-정지-조건)에서만 멈춘다.

사람이 정확한 설계 버전과 범위를 승인한 뒤 구현한다. 승인은 대화·이슈·PR 등 확인 가능한 근거와 문서 커밋으로 고정한다. 승인 범위 안의 다음 단계는 다시 묻지 않는다. 범위·제품 동작·데이터 규약·주요 구조·인수조건이 실질적으로 달라지면 변경 설계를 검토받는다. 사람 승인을 에이전트가 만들어내지 않는다.

승인 후 레포별 [실행 티켓](templates/execution-ticket.md)을 만들거나 충분한 기존 접수 이슈를 보강한다. Wiki는 날짜·승인 순서별 목록·요약과 최신 원본·승인 커밋·티켓·PR·검수 링크를 제공한다. 본문을 Wiki·Obsidian에 복사해 따로 수정하지 않는다. Obsidian에는 기획·검토·승인·회고와 정본 링크를 남긴다. Wiki를 사용할 수 없으면 `docs/design/README.md`로 같은 목록을 제공하고 Wiki 게시 완료라고 하지 않는다.

## 테스트 우선 구현

인수조건별로 `요구사항 때문에 실패하는 테스트 → 최소 구현 → 통과·관련 회귀 확인`을 수행한다. 테스트 문법·환경 오류는 실패 증거가 아니다. TDD를 적용할 수 없는 부분은 승인 설계에 이유와 대체 검증을 적고 결과를 남긴다. 에셋·플랫폼 연동 등의 예외가 전체 테스트나 실제 UI 실행의 면제가 되지 않는다. 별도 리팩토링은 기존 품의 규칙을 따른다.

조건 식별자를 설계·티켓·테스트·PR·검수에 연결한다. 실패·통과 로그와 미실행·차단을 구분한다.

## 테스트 등급과 계획

변경의 크기와 위험에 맞춰 테스트 깊이를 **설계 단계에서** 정한다. 레포 `docs/design/<id>/test-plan.json`([형식](../../contracts/test-plan.schema.json), [예시](templates/test-plan.example.json))에 적고, 사람이 설계와 같은 커밋으로 한 번 승인한다.

| 등급 | 테스트 범위 | 실행 환경 | 실행·검수 | 예시 |
|---|---|---|---|---|
| **L1** | 바뀐 기능만 | 개발 환경: Godot·Unity Editor, RN Web·개발 서버, 서비스 런타임 | 작성자가 직접 실행해 기록 | iOS에서 동의 창 표시 분기, 문구·수치 조정, 화면 하나의 버그 수정 |
| **L2** | 바뀐 기능만 | 실기기: Android 기본, iOS는 설계에서 선택. 개발 환경 추가 가능 | 실기기 실행은 다른 에이전트 | 광고·결제·권한 동작 변경, 네이티브 플러그인 설정 |
| **L3** | 바뀐 기능 + 전체 회귀 | 개발 환경 / Android / iOS / 둘 다 중 설계에서 선택 | 모든 실행을 다른 에이전트 또는 [확인된 CI 실행](#ci-실행)이 함. 새 화면·UI 개편이면 3회 검수 | SDK·엔진·의존성 업그레이드, 저장 형식 변경, 공통 구조 변경 |

| `test-plan.json` 필드 | 규칙 |
|---|---|
| `level` | L1은 `environments: ["dev"]`만. L2는 `android`·`ios` 중 하나 이상(`dev` 선택). L3는 비어 있지 않은 아무 조합 |
| `baseline` | 대상 마켓의 현재 공개 버전 태그 또는 전체 회귀를 통과한 마지막 릴리스 태그. 후보의 조상이어야 한다. 첫 출시는 `null`이며 L3만 허용 |
| `changedFeatures` | 기능 목록의 ID. 새 기능은 기능 목록에 먼저 추가 |
| `environments` | `dev`·`android`·`ios`. 적은 환경마다 범위 안의 기능을 모두 실행 |
| `redesign` | 새 화면·UI 개편이면 `true`. L3이어야 하며 [재설계 검수 3회](#재설계-ui-검수-3회)를 한다 |
| `foundationRerun` | L3에서만 `true`. 기반 기능도 이어받지 않고 다시 실행 |
| `floorOverrides` | 아래 하한을 낮춘 항목과 사유. `{rule: "foundation", featureId, reason}`(기능 목록 v1), `{rule: "platform", featureId, reason}`(기능 목록 v2) 또는 `{rule: "regression", reason}` |
| `release` | 개발 환경 검사와 PR 병합만 승인하면 `null`. 출시를 승인하면 기존 객체: `markets`(출시할 마켓), `until`(`test-track` / `review-submitted` / `public`, 생략하면 `public`), `rollout`(Play 단계적 출시 비율, 선택) |

한 후보에 승인 설계가 여러 개 묶이면 등급은 가장 높은 값, 기능·환경·마켓은 합집합, 끝 지점은 가장 이른 값을 쓴다. 하한 낮춤은 묶인 모든 계획에 같은 항목이 있을 때만 인정한다.

하나라도 `release: null`이면 전체 후보는 개발 전용이다. 다른 계획의 출시 객체로 이를 덮을 수 없으며 마켓, 끝 지점과 비율을 출시 승인으로 사용하지 않는다. `release` 생략은 허용하지 않는다. [개발 전용 예제](templates/test-plan.development-only.example.json)를 참고한다. null 계획에 마켓별 `platformValidation`을 넣으면 시장이 계획되지 않았다는 오류를 반환한다.

### 검증기가 계산하는 하한

검증기는 계획의 `baseline`부터 후보까지 바뀐 파일로 최소 범위를 계산한다. 계획이 하한보다 낮으면, 승인된 계획에 해당 `floorOverrides`가 있을 때만 통과한다. 근거 파일이나 승인 뒤 커밋에 적은 낮춤은 인정하지 않는다.

| 바뀐 파일 | 하한 | 낮추기 |
|---|---|---|
| 기능의 `paths` | 그 기능을 계획한 환경에서 실행 대상에 추가 | 해당 없음 |
| 기능 목록 v1: 기반 기능(`foundation: true`)의 `paths`, 또는 `changedFeatures`의 기반 기능 | 그 기능을 **검증 중인 마켓 플랫폼의 실기기**에서 실행(L2) | `{rule: "foundation", featureId}` |
| 기능 목록 v2: 기능의 `platformPaths`, 최상위 `platformPaths`, 첫 출시, 새 플랫폼 기능 | [Godot headless E2E와 플랫폼 경로](#godot-headless-e2e와-플랫폼-경로) | `{rule: "platform", featureId}`. 첫 출시·새 플랫폼 기능의 하한을 면제할 수 없음. 아래 실제 SDK 개발 검수로 충족 가능 |
| `regressionPaths`(기능 목록에 없으면 [중앙 기본값](../../contracts/development-workflow.yaml)의 엔진·export·플러그인·네이티브 빌드 설정·잠금 파일) | 계획한 환경마다 전체 회귀(L3) | `{rule: "regression"}` |
| 비교 불가(기준이 후보의 조상이 아님, 300개 이상, 조회 불가) 또는 `baseline: null` | 전체 회귀(L3) | `{rule: "regression"}`. 첫 출시는 낮출 수 없음 |
| `redesign: true` | L3·3회 검수 | 낮출 수 없음 |

또한 v1 기반 기능 하한도 다른 마켓의 기기 실행으로 채울 수 없다. 이 대상 마켓 검사를 제외한 기존 계획 판정은 유지한다.

플랫폼 연결: `google-play`→Android, `app-store`→iOS, `apps-in-toss`→Android 또는 iOS 중 하나, `web`·`service`→실기기 없음.

착수 뒤 예상하지 못한 경로를 건드려 하한이 올라가면 **사람에게 묻지 않고** 그 실행을 더한다. 계획 파일은 바꾸지 않는다. 검증기는 실제 실행이 하한을 채우면 통과시킨다. 반대로 계획보다 테스트를 줄이려면 설계를 다시 승인받는다.

### 기능 목록

제품의 구현 기능 전체를 소스 `docs/qa/feature-inventory.json`에 `schemaVersion: 1`로 유지한다([예시](templates/feature-inventory.example.json)). headless E2E 틀과 CI가 준비된 Godot 게임은 `schemaVersion: 2`([예시](templates/feature-inventory-v2.example.json), [규칙](#godot-headless-e2e와-플랫폼-경로))로 올린다. 모든 기능에 선택 `paths`(저장소 기준 glob)를, 최상위에 선택 `regressionPaths`를 적는다. 기반 기능은 `"foundation": true`와 `paths`가 필수다. `paths`가 없는 기능은 하한 계산에서 자동으로 추가되지 않으므로 바뀐 기능을 `changedFeatures`에 직접 적는다.

## Godot headless E2E와 플랫폼 경로

[승인 설계](../design/2026-10-16-godot-headless-e2e/design.md). Godot 게임은 headless E2E를 기본 실행 환경으로 쓰고, 실기기는 플랫폼 변경·첫 출시·새 플랫폼 기능(결제·로그인을 처음 붙이는 경우 등)에만 쓴다. RN 비게임 앱은 기능 목록 v1 규칙을 그대로 쓴다.

### headless E2E 기준

실행 종류 `godot-headless-e2e`로 인정하는 최소 기준이다. probe·단위 테스트·스크린샷만으로는 인정하지 않는다.

| # | 기준 |
|---|---|
| E1 | 실제 시작 장면과 실제 UI 트리를 띄운다. 화면을 우회하는 테스트 전용 장면을 쓰지 않는다 |
| E2 | 대체 구현은 플랫폼 경계(광고·결제·로그인·클라우드 저장·원격 설정·분석·시계·난수)에만 둔다 |
| E3 | 입력은 화면 좌표의 실제 입력 이벤트(터치·클릭·드래그)로 넣는다. 함수 직접 호출로 화면을 건너뛰지 않는다 |
| E4 | 시작 → 기능 사용 → 저장·화면 전환 → 오류·취소·복구 → 종료·재실행 후 저장 복원을 한 여정으로 잇는다 |
| E5 | 임시 저장 경로, 고정 시드·시계, 기기 논리 해상도 `SubViewport`로 격리하고 실행마다 같은 결과를 낸다 |
| E6 | 시나리오의 기능 ID 합이 기능 목록의 모든 기능을 포함한다 |
| E7 | `journey.json`(시나리오·기능 ID·통과 여부)을 쓰고, 실패 시 exit 1, 로그의 `SCRIPT ERROR`·`ERROR:` 검사, 명령 시간 제한 |
| E8 | 화면 변경은 같은 여정을 렌더링 모드(`--headless` 없이)로 돌려 장면별 PNG를 남긴다. headless는 그림을 그리지 않는다 |

작성 방법은 `~/.agent`의 `godot-game` 스킬 `references/headless-e2e.md`에 둔다. Godot 게임 작업을 시작할 때 기능 목록이 v1이거나 E2E 틀이 기준에 못 미치면 그 게임의 다음 작업에서 먼저 틀을 만들고(E2E 여정 → CI → 기능 목록 v2), 그 전 릴리스는 v1 규칙으로 검증한다. 제품 동작을 바꾸지 않는 테스트 코드·CI·기능 목록 변경은 위 설계의 승인으로 진행하고, 대체 구현 주입을 위해 제품 구조를 바꾸면 그 게임의 설계에 포함한다.

### 기능 목록 v2

| 필드 | 뜻 |
|---|---|
| `e2e.workflow` | 게임 저장소에서 후보 SHA의 headless E2E를 돌리는 workflow 파일(중앙 재사용 workflow를 부르는 caller, 예: `.github/workflows/godot-checks.yml`). 필수. [CI 실행](#ci-실행) 확인에 쓴다 |
| `e2e.command` | 선택. 로컬·CI에서 쓰는 명령(예: `npm run test:e2e`) |
| `features[].platformPaths` | 바뀌면 그 기능을 실기기에서 실행해야 하는 경로(네이티브 플러그인, SDK 호출 구현). 대체 구현 뒤의 게임 로직·화면은 넣지 않는다 |
| 최상위 `platformPaths` | 바뀌면 플랫폼 기능 전체(없으면 핵심 기능)를 실기기에서 실행. 생략하면 [중앙 기본값](../../contracts/development-workflow.yaml)의 `defaultPlatformPaths` |
| `foundation`·`paths` | 기능 실행 범위와 [이어받기](#영향-없는-기반-기능)에 그대로 쓴다. v2에서는 실기기 하한을 만들지 않는다 |

| 바뀐 파일·상황 | v2 하한 | 낮추기 |
|---|---|---|
| 기능 `paths`(기반 기능 포함) | 그 기능을 계획한 환경에서 실행 | 해당 없음 |
| 기능 `platformPaths` | 그 기능을 검증 중인 마켓 플랫폼의 실기기에서 실행(L2) | `{rule: "platform", featureId}` |
| 최상위 `platformPaths` | 플랫폼 기능 전체(없으면 핵심 기능)를 실기기에서 실행 | 기능마다 `{rule: "platform", featureId}` |
| `baseline: null`(첫 출시·새 마켓) | 전체 회귀 + `platformPaths`가 있는 기능 전체를 실기기에서 실행 | 낮출 수 없음(`platform-first`) |
| 기준 태그의 기능 목록에 없던 기능의 `platformPaths` | 그 기능을 실기기에서 실행 | 낮출 수 없음(`platform-first`) |

바뀐 파일은 후보와 기준 태그의 플랫폼 경로(기능별·최상위)를 합쳐 판정한다. 후보에서 경로를 지우거나 좁혀도 그 릴리스의 하한은 줄지 않는다. 기준 태그의 기능 목록을 읽을 수 없거나 형식이 맞지 않으면 모든 플랫폼 기능을 새 기능으로 보고 중앙 기본 경로를 더한다. 엔진 업그레이드는 경로로 다 잡히지 않으므로 설계에서 L3와 `android`(필요하면 `ios`)로 계획한다. `{rule: "platform"}`은 v1에서, `{rule: "foundation"}`은 v2에서 계획 오류다.

### 초기 검수 기록의 결손 복구

v2의 선택 `reviewHistoryRecovery`는 최초3회의 sourceSha/plannedAt/startedAt 중 실제 결손이 있는 경우만 사용한다. reason과 정확3개 attempts를 기록하고 회차1~3, 원본 판정, completedAt, reviewer, evidence와 originalReportSha256을 보존한다. 모르는 값은 null이고 실패/차단에는 resolutionEvidence가 필요하다. 알려진 날짜와 순서를 검사하며 hash는 보존 원본의 식별 선언이다. 실행자가 원본 bytes와 판정을 별도 대조해야 하고 verifier가 임의 증거 URL의 진위를 보증하지는 않는다.

과거3회는 합격 수에는0회, 승인 상한에는3회로 센다. 새 reviewRounds는4부터 시작하고 최소3개의 완전한 독립 검수가 필요하다. 모든 새 회차는 현재 후보 SHA와168시간 기한을 충족해야 하며, 완전한 회차는 전체 기능의 기능/UX를 검수해야 한다. 중단 회차의 명시 기록과0회 계산은 아래 현재 후보 중단 규칙을 따른다. 최초3회 종료 후이면서 새 계획 전인 human 추가 승인이 각 실제 회차 번호를 덮어야 한다. 최종 통과, 실패 해결, 실행/플랫폼/출시 게이트는 그대로다. 이력 일부 삭제, 회차1로 재명명, 예전 통과 회차의 합격 수 전용은 차단한다. 정상 v2와 v1 계약은 바꾸지 않으며 v1에는 이 복구 필드가 없다.

그 뒤 이전 후보에서 실제 완료한 회차가 있으면 같은 객체의 선택 `completedRounds`에 보존한다. 각 항목은 원래 `round` 전체, 당시 `implementer`, 원본 `originalReportSha256`과 `evidence`를 갖는다. 이 완전 기록은 SHA와 계획/시작/완료 시각에 null을 허용하지 않고, 당시 구현자와 검수자의 독립성, 알려진 시각과 연속 번호, 실패 해결을 검사한다. 과거 회차도 최초3회 종료 이후이면서 자기 계획 이전에 존재한 추가 승인과 실제 번호 상한이 필요하다. 나중 승인으로 소급 승인하지 않는다. 원본 bytes와 판정은 위와 같이 실행자가 별도 대조한다.

과거 완전 회차는 새 후보 합격 수에0회이며 당시 기능 범위에 새 기능 목록을 소급 적용하지 않는다. 예를 들어 `attempts`가1~3, `completedRounds[].round.number`가4이면 새 `reviewRounds`는5~7로 시작하며 같은 현재 후보의 완전한 독립 검수 최소3회가 필요하다. 그 새 승인은 과거4회 완료 후이면서 새5회 계획 이전이어야 하며 각 회차 번호를 덮어야 한다. 원래 상한6과 새 상한7의 승인은 `additionalIterationApprovals`에 원래 시각/근거로 각각 보존한다. 현재 후보의 전체 기능, 독립성, 사전 계획,168시간과 플랫폼/출시 조건을 면제하지 않는다.

이전 후보의 부분 중단은 선택 `reviewHistoryRecovery.interruptedRounds`에 별도로 보존한다. 각 항목은 완전 과거 회차와 같은 `round`,당시 `implementer`,`originalReportSha256`,`evidence`를 갖고, 원래 `round.interruption`의 사유,실제 completed/incomplete/notRun 범위와 원본 해시를 필수로 남긴다. 바깥 원본 해시와 interruption의 원본 해시는 같아야 한다. 알려진 SHA와 계획/시작/완료 시각은 null로 바꾸지 않고 기능과 UX의 failed 또는 blocked 판정,독립 검수자 및 실제 후속 `resolutionEvidence`를 보존한다. 원본 bytes,시각,판정,부분 범위와 해결은 실행자가 별도 대조하며 이 필드 자체가 임의 증거 URL을 인증하지 않는다.

완전 과거와 중단 과거는 각 배열에서 원래 번호 순으로 적고 두 배열을 합쳐 초기 결손3회 뒤의 실제 연속 번호,시간 순서,중복과 누락,당시 독립성과 사전 승인 및 실제 상한을 검사한다. 중단 과거도 현재 완전 검수 수0회,실제 순번과 승인 상한1회다. 예를 들어 결손1~3,완전4~9,중단10,완전 실패11 뒤에는 같은 새 후보의 현재12~14 세 완전 독립 전체 검수가 필요하다. 새 승인은 모든 과거 회차의 마지막 완료 이후이면서 각 새 계획 이전이어야 한다. 마지막 현재 회차는 기능과 UX가 통과하고 과거 실패도 실제 재검수 해결 근거가 있어야 한다. 중단을 `completedRounds`에 넣는 것은 계속 거절한다. 기존 정상 v2와 v1의 의미,현재 회차 SHA와168시간,전체 기능,플랫폼/실행/출시 하한은 바꾸지 않는다. 이 필드 추가는 새 검수 실행이나 기기 및 출시의 승인이 아니다.

### 실제 SDK를 사용하는 네이티브 개발 검수

[승인 설계](../design/2026-10-18-native-development-validation/design.md). 기능 목록 v2의 플랫폼 하한은 기기 사용 허가가 아니다. 개발 환경으로 확인할 수 없는 필수 항목이 있을 때만 별도로 소명·승인받아 기기를 사용한다. 개발 환경으로 충분하면 아래의 승인된 실제 SDK 실행으로 하한을 충족할 수 있다. 일반 headless·단위 테스트로 플랫폼 하한을 면제하지 않는다.

승인 `test-plan.json`의 선택 배열 `platformValidation`에 `{featureId, target, kind: "native-development", reason, configurationFingerprint, checks: ["sdk-completion", "server-delivery"]}`를 적는다. 해당 기능에 `platformPaths`가 있고 그 마켓과 dev 환경이 계획에 있어야 한다. 모든 결속 설계에 같은 기능·마켓의 승인이 있어야 하며 `checks`는 합집합으로 검사한다.

실제 실행의 kind는 `native-development`다. `nativeSdk`에 `mode: "real"`, `runtime: "ios-simulator" | "android-emulator"`, `sdkNames`, `artifact: {path, sha256}`, `limitations`를 적고 실행의 `target`·`build`·`configurationFingerprint`도 필수로 남긴다. 대역 SDK는 인정하지 않으며 실제 SDK 실행 로그·산출물과 대조한다. 같은 후보 SHA·168시간·설정 지문·독립 실행자 조건과 하나의 실행 안의 필수 시나리오 ID·기능 커버리지를 검사한다. nativeSdk 실행은 현재 headless CI 인증 경로로 독립 실행을 주장할 수 없다(`executor: ci` 불가).

이 경로는 일반 platform 하한과 첫 플랫폼 기능의 platform-first 하한을 **충족**하는 방법이다. 승인 없는 생략이나 `floorOverrides`로 platform-first를 면제하는 것은 여전히 금지한다. 계획의 android/ios 환경을 적은 경우의 전체 실행 요구도 바꾸지 않는다. App Attest·하드웨어 반응 등 실제 기기에서만 확인할 수 있는 필수 항목은 이 대체 목록에 넣지 않는다. 다른 마켓·플랫폼의 실행, 누락·미실행·차단은 통과가 아니다.

승인 계획의 `configurationFingerprint`는 실제 출시 설정 파일과 값을 기준으로 계산해 승인 시 고정한다. 실제 SDK 실행의 지문은 CLI 지문 인자가 없어도 이 승인 지문과 항상 같아야 한다. 여러 설계의 승인 지문이 다르면 대체 검수를 인정하지 않는다. 파생 빌드에서 제외한 플러그인 등은 limitations로 별도 명시하며 승인된 광고/서버 설정을 바꾸지 않는다. 후보에서 해당 기능의 platformPaths를 제거하면 기존 대체 검수 계획은 무효이며 새 계획 검토가 필요하다.

### CI 실행

`executor: "ci"` 실행은 `ciRun.url`(`https://github.com/<owner>/<repo>/actions/runs/<id>`, 선택 `/attempts/<n>`)이 필수이고 개발 환경 종류만 쓴다. 검증기는 GitHub API로 같은 저장소, `head_sha` = 후보 SHA, `completed`·`success`, workflow 경로 = 기능 목록 `e2e.workflow`를 확인한다. 확인된 CI 실행은 구현자와 다른 실행자로 보며 168시간 기한은 API의 `updated_at`으로 잰다. 로컬 `--file` 검증도 `GH_TOKEN`·`GITHUB_TOKEN`으로 조회한다. 토큰이 없거나 조회에 실패하면(404·403·5xx 등) `CI_RUN_UNVERIFIED`로 통과시키지 않는다. 실기기 실행의 독립 실행자 규칙은 그대로다.

중앙 `godot-checks.yml`에 `check_command`(예: `npm run test:e2e`)와 `e2e_report_path`(예: `build/e2e`)를 주면 결과를 `headless-e2e-<sha>` artifact로 조직 보존 기간(3일) 동안 둔다. 시나리오는 그 `journey.json`에서 옮겨 적고, 증거 링크는 CI 실행 URL로 남긴다. artifact가 지워진 뒤에도 실행 확인은 API로 한다.

### 사용자의 테스트 채널 확인

테스트 채널 업로드 뒤 TestFlight·Play 내부 테스트·앱인토스 링크를 알리고 기다리지 않고 계획의 끝 지점까지 진행한다. 사용자의 확인은 게이트가 아니며 `runs`에 넣지 않는다. 사용자가 결함을 알리면 테스트 실패로 다룬다. 승인 범위 안이면 고쳐 새 후보로 진행하고, 범위 밖이면 [정지 조건](#승인-뒤-진행과-정지-조건) 1로 보고한다. 먼저 확인하고 싶은 릴리스는 계획의 `release.until`을 `test-track`으로 정한다.

## 재설계 UI 검수 3회

새 화면·UI 개편(`redesign: true`)에만 적용한다. 각 회차 시작 전에 [회차 계획·보고서](templates/iteration.md)를 작성한다. 후보 SHA, 핵심 기능 전체, 기능·UX 항목과 기대 결과, 순서, 환경, 검수자 페르소나, 격리 데이터·저장 경로, 증거·통과 기준을 정한다.

`계획 → 실제 실행 → 독립 검수 → 범위 안의 수정 → 해당 문제 재확인 → 결과 기록`을 3회 수행한다. 매 회차의 "핵심 기능 전체"에서 [영향 없는 기반 기능](#영향-없는-기반-기능)은 이어받은 근거로 대신한다. 1회가 통과해도 2·3회를 수행한다. 계획을 소급 작성하거나 한 회차의 반복을 무제한 늘려 상한을 우회하지 않는다.

| 회차 | 매번 기능·UX 모두 검수하며 집중할 점 | 페르소나 |
|---|---|---|
| 1 | 핵심 기능 전체의 인수조건·입력·상태·결과·저장과 행동·결과의 이해 | 요구사항 검수자·처음 사용자 |
| 2 | 핵심 기능 재실행, 오류·취소·복구, 탐색·피드백·작은 화면·큰 글자·키보드·접근성 | 사용자 관점 검수자·필요 시 UX 전문가 |
| 3 | 핵심·기존 기능 연결, 회귀·재시작·저장 복구와 작업 전체의 자연스러운 완료 | 회귀·복구 검수자·반복 사용자 |

검수는 구현자와 **다른 리뷰 에이전트**가 실행 근거를 읽고 실제로 재현한다. 작성자의 역할 전환은 독립 검수가 아니다. 공유 기기는 순서를 조율하고 검수자가 코드·데이터를 임의 수정하지 않는다. 페르소나 검수는 실제 사용자 조사와 구분한다. UX 전문 역할은 새 탐색 구조·복잡한 입력·이해·접근성 문제나 판단 불일치가 있을 때 추가한다.

보고서는 `항목 → 관찰·증거 → 기능/UX 문제 → 사용자 영향 → 수정 제안 → 판정`을 남긴다. 이전 회차의 실패 판정은 보존하고 해결·재검수 링크를 `resolutionEvidence`로 연결하며 최종 회차의 기능·UX는 통과해야 한다. 3회 뒤 미충족 조건·주요 결함·미검수 항목이 남으면 문제와 근거, 추가 회차·범위, 시간·비용, 검수자·환경, 중단 영향을 사람에게 품의한다. 승인 전에 4회차를 시작하지 않는다. 3회차를 최종 후보 SHA에서 전체 기능으로 실행했으면 같은 실행을 `runs`에도 기록해 최종 회귀 실행으로 쓴다.

정상 v2 근거는 기존 `additionalIterationApproval` 단일 객체 또는 null 형식을 계속 지원한다. 회차별로 별도 승인받았으면 선택 필드 `additionalIterationApprovals`에 기존 승인 객체의 배열을 기록하고 단일 필드는 명시적으로 null로 둔다. 비어 있는 배열, 두 입력 방식의 동시 사용, 같은 `maxRound`의 중복·상충 기록과 유효하지 않은 승인 시각은 거절한다. 배열 순서에 의존하지 않으며 각 추가 회차는 자기 계획 전에 존재한 유효 승인(`maxRound >= 회차 번호`, `approvedAt <= plannedAt`)을 찾아야 한다. 승인 원문의 시각·한도·근거를 보존하고, 예전 승인 시각과 나중 한도를 합친 단일 승인으로 소급 작성하지 않는다. 이 입력 확장은 새 회차 실행이나 예산·기한·실기기·L3 검증의 면제가 아니다. v1/bootstrap의 기존 입력과 별도로 적용한다.

### 현재 후보에서 중단된 검수

v2의 선택 `reviewRounds[].interruption`은 실제 실행을 시작했으나 전체 검수를 완료하지 못한 회차를 보존한다. `reason`, 원본 `originalReportSha256`, `evidence`와 `actualScope`를 적는다. 실제 실행 단위의 식별자는 `actualScope.completed`, `incomplete`, `notRun`으로 나누고 미완료 또는 미실행 단위가 적어도 하나 있어야 한다. 같은 단위를 여러 상태에 넣지 않는다. 원래 SHA,계획/시작/완료 시각,검수자와 기능/UX의 failed 또는 blocked 판정은 바꾸지 않는다. 원본의 실제 bytes/hash,판정,부분 범위와 알려진 시각은 실행자가 대조한다. URL 진위나 원본 파일은 이 필드만으로 인증되지 않는다.

이 회차는 완전 검수 수에0회, 실제 회차 순서와 승인 상한에1회로 센다. 원래 featureIds가 요구 범위를 가리킨 경우 실제로 완료한 전체 검수로 해석하지 않는다. 이 경로에서도 최소3개의 완전한 현재 후보 독립 검수를 요구한다. 중단을 포함한 모든 현재 회차의 같은 SHA,168시간,사전 계획,독립성과 실제 상한 승인은 유지하고, 중단되지 않은 회차는 전체 기능의 기능/UX를 검수해야 한다. 기존 실패의 실제 후속 해결은 `resolutionEvidence`로 연결하고 마지막 회차는 중단 표시 없이 기능/UX가 모두 통과해야 한다. 예를 들어8,9가 완전하고10이 중단됐으면 새 사전 승인 후 실제11 전체 검수까지 완료해야8,9,11을 세 회로 센다.10의 종료나 실패를 지우거나 다시 실행한 것으로 쓰지 않는다.

중단 표시는 승인된 redesign 검수에만 사용하며 완전한 과거 `completedRounds`로 옮길 수 없다. 새 후보에서는 위의 별도 `interruptedRounds`로 원형을 보존한다. 기존 최초3회와 모든 과거 회차의0회 규칙,실행/플랫폼/출시 하한과 정상 v2 및 v1 동작은 유지한다. v1은 이 필드를 지원하지 않는다. 이 기록 경로 자체는 다음 회차나 재실행,기기 사용과 출시의 승인이 아니다.

## 승인된 과거 회차 범위 예외

[Lizard Tycoon 1.9.0의 사용자 승인](../design/2026-10-19-lizard-190-historical-coverage/design.md)은 후보 `055aae4422610e279417f3f3a7d2b9007cb1754d`와 중앙에 등록된 마켓별 실제 근거 해시에만 적용한다. 정상 v2 검증을 먼저 실행하며, 현재 후보의 마지막 회차 기능과 UX가 통과하고 과거 `ux-1`, `functional-4`, `ux-4`의 범위 오류 세 개만 남을 때 `human_exception` 결정을 반환한다. 원래 failed 판정은 `originalVerdict`에 보존하며 CLI에도 출력한다.

다른 후보, 태그, 자료, 오류와 만료는 허용하지 않는다. 빌드와 테스트 업로드에만 적용하며 before-release와 공개 배포인 web 및 service의 before-deploy는 거절한다. 기존 실패와 당시 실제 범위를 고쳐 쓰지 않으며 CI, 실행자, 최종 회차, 플랫폼과 출시 검사는 유지한다. Google Play before-deploy 예외는 [승인된 내부 업로드 설계](../design/2026-10-19-lizard-190-internal-upload-scope/design.md)에 따라 실제 트랙 internal과 작업 upload만 허용한다. 두 관측값이 없거나 승격이면 원래 실패를 유지한다. 새 생략 flag는 없다. [중앙 grant](../../contracts/historical-review-coverage/lizard-tycoon-1.9.0.json)는 현재 CI의 168시간 기한 이내에서만 유효하고 만료 후 제거 대상이다. 일반 제품과 v1의 검증 동작은 바뀌지 않는다.

## 실행과 단계별 검사

계획한 환경마다 범위 안의 기능을 실제로 실행하고 [실행 기록](templates/run.md)을 남긴다. 주요 작업은 시작→기능 사용→저장·화면 전환→오류·복구→종료·재실행을 이어서 실행한다. 스크린샷·코드 열람·headless 단위 테스트만으로 실제 실행을 대신하지 않는다. [기준](#headless-e2e-기준)을 채운 Godot headless E2E는 개발 환경 실행이다. 사용자 저장·계정·데이터와 격리하고 초기화 전 저장 경로를 확인한다.

| 환경 | 실행 종류(`runs[].kind`) | 방법 |
|---|---|---|
| 개발 환경(`dev`) | `godot-editor`, `godot-headless-e2e`, `unity-editor`, `web-browser`, `native-development`, `service-runtime` | Editor Play/Run, [Godot headless E2E](#headless-e2e-기준), 개발 서버+실제 브라우저, 개발용 런타임, 서비스 API E2E |
| Android(`android`) | `android-device` | adb 실기기. 테스트 채널 빌드(Play 내부 테스트 등) 또는 같은 SHA 로컬 빌드 |
| iOS(`ios`) | `ios-device` | 실기기. TestFlight 빌드 또는 같은 SHA 로컬 빌드 |

모든 실행은 후보 SHA와 정확히 같아야 하고 168시간 안이어야 한다. 실기기 실행은 `target`(설치한 빌드의 마켓)·`device`·`build`를 적고, 검증 중인 마켓의 실행이면 설정 지문을 적는다. 개발 환경 실행은 테스트용 대체 구현을 쓰므로 마켓 설정 지문과 대조하지 않는다. 필수 시나리오의 미실행·차단·실패는 통과가 아니다.

| 단계 | 호출 위치 | 요구하는 실행 |
|---|---|---|
| `before-build`, `before-deploy` | 중앙 빌드·업로드 workflow, Xcode Cloud 훅 | 계획의 개발 환경 실행. 실기기 실행은 아직 없어도 된다 |
| `before-release` | Play production 승격 workflow, App Store·앱인토스 심사 제출 직전 로컬 실행 | 계획의 모든 실행(실기기 포함)과 하한, 출시 범위(`release.markets`에 대상 마켓, `until`이 `test-track`이 아님) |

Spiritgate의 Mac-only 생략 후 통합 승인 계획(`2026-10-16-native-release-handoff`, 승인 커밋 `cfe7ee914c980f39d8bf6ca062f86eb1912606fe`의 같은 폴더 `design.md`/`test-plan.json` 하나)에 한해, `google-play`/`app-store`의 dev 없는 계획은 `before-build`/`before-deploy` UI3 횟수를 실제 기기 실행과 같은 공개 전 단계로 미룬다. 앞선 승인 계획·원문 조회와 후보 조상 검증을 그대로 통과해야 하며, 다른 repo/새 계획/다른 마켓·단계 또는 `dev` 포함 계획의 기존 조기 UI3 조건은 유지한다. 기록한 회차의 순서·독립성·승인·실패 해결 검사는 어느 단계에서도 생략하지 않는다. 공개 전 UI3·인수조건·TDD·L3·실기기 하한·공개 전체 회귀는 그대로다.
| `web`·`service`의 `before-deploy` | 공개 배포 workflow | 모든 실행과 출시 범위(테스트 채널이 없다) |

개발 전용 후보는 마켓 작업 진입용 `before-build`, `before-deploy`, `before-release`에서 모두 `RELEASE_NOT_AUTHORIZED development-only`로 차단한다. 테스트 채널과 web, service도 포함한다. 로컬 개발 테스트와 PR 정적 검사는 계속 실행하며, 이를 위해 가짜 출시 근거를 만들지 않는다.

Play의 테스트 트랙 사이 승격은 `before-deploy`, production 승격은 `before-release`로 검사한다. 승격 workflow는 `rollout` 입력(비면 완전 출시 1)을 검증기에 넘기고, 승인된 계획의 비율보다 크면 막는다. 여러 계획이 묶이면 가장 작은 비율이 상한이다. App Store·앱인토스 심사 제출은 중앙 workflow가 하지 않으므로 실행자가 제출 직전에 `--phase before-release`를 실행한다.

### 영향 없는 기반 기능

결제·광고·로그인·클라우드 저장·원격 설정·분석·권한처럼 실기기·외부 서비스가 필요한 기반 기능은 L3 전체 회귀에서 이어받을 수 있다. 바뀐 기능(`changedFeatures`·경로가 겹친 기능)은 이어받지 않는다. `foundationRerun: true`이면 이어받지 않는다. 제품 기능은 이어받지 않는다.

| 조건 | 판정 |
|---|---|
| 기준 SHA(그 기능을 실제로 실행해 통과한 SHA)부터 후보까지 바뀐 파일(이름 변경 전후 포함)이 `paths`와 겹치지 않음, 기준 SHA의 같은 기능 정의와 `paths`가 같음, 실제 실행 후 30일 이내 | 회귀·재설계 회차에서 생략하고 근거의 `carriedForward`에 기록 |
| 경로가 겹침, 기준이 후보의 조상이 아님, 변경 파일 300개 이상, 기준 커밋·기능 목록을 읽을 수 없음, 정의 변경, 30일 초과 | 다시 실행 |

`carriedForward` 항목은 `featureId`, `baselineSha`, `verifiedAt`, `evidence`를 가진다. 이어받은 근거를 다시 이어받을 때도 기준 SHA·실행 시각·증거는 원래 실제 실행 값을 유지한다. 영향 판정은 검증기가 하며 에이전트 판단으로 목록을 줄이지 않는다. `paths`를 좁히는 변경은 기준 정의와 달라져 다시 실행하게 된다.

## 승인 뒤 진행과 정지 조건

승인된 계획의 `release`가 객체일 때 배포 요청이다. `release: null`이면 구현, 개발 환경 검증과 PR 병합에서 마치며 태그, 마켓 빌드, 업로드, 제출과 공개를 하지 않는다. 이후 출시는 `release`를 객체로 바꾼 설계와 테스트 계획의 새 정확한 커밋에 대한 사람 승인이 필요하다. 구현→PR·CI·리뷰·병합→계획한 실행→태그·빌드·테스트 채널 업로드→실기기 실행(계획·하한이 요구할 때)→심사 제출·승격→승인 후 공개·live 확인을 `until`까지 이어서 진행한다. [사용자의 테스트 채널 확인](#사용자의-테스트-채널-확인)은 기다리지 않는다. 단계마다 사람에게 다시 묻지 않는다. 테스트를 **더 하는** 쪽(하한 상향, 환경 추가)도 묻지 않는다. 빌드·업로드·심사·승인·공개·live 확인은 서로 다른 상태로 기록한다.

아래 경우에만 멈추고 사람에게 보고한다.

1. 테스트 실패를 승인 범위 안에서 고칠 수 없다(제품 동작·데이터 규약·구조·인수조건이 바뀌어야 함).
2. 검증기·required check·ruleset이 막는다. 우회하지 않는다.
3. 계획한 환경을 쓸 수 없다(예: iOS 실기기 없음). 계획을 낮추려면 다시 승인받는다.
4. 마켓 거절이 승인 범위 밖의 수정을 요구한다. 문구·메타데이터 같은 범위 안 수정은 고쳐서 다시 제출한다.
5. 새 화면·UI 개편 3회 뒤에도 미해결이다.
6. 기존 개별 승인 대상: 결제 상품·가격·정산, 자격증명 생성·교체, 데이터 삭제·복구, 지원팀 연락.

## 기계 검증과 증거 보존

[development-evidence.schema.json](../../contracts/development-evidence.schema.json)(v2)의 예제는 [development-evidence.example.json](templates/development-evidence.example.json)이다. 이 예제는 가상 데이터이며 제품 검수 증거가 아니다. 보고서 본문은 `docs/qa/<design-id>/`, 대용량 로그·영상은 제품 정책에 맞는 보존 위치에 두고 URL·해시·환경을 연결한다. 만료·삭제된 링크를 살아 있는 증거로 표시하지 않는다.

| 근거 필드 | 내용 |
|---|---|
| `designs[]` | 설계 ID, `document`, `testPlan`(같은 설계 폴더의 `test-plan.json`), `approvedCommit`, 사람 승인자·근거. 여러 설계를 묶을 수 있다 |
| `acceptance`, `tdd` | 인수조건별 통과와 TDD 실패·통과 또는 사유·대체 검증 |
| `runs[]` | 실행마다 `kind`, 후보 SHA, `executor`, 계획·시작·종료 시각, 격리 데이터, 통과 시나리오와 기능 ID. 실기기는 `target`·`device`·`build`·설정 지문 |
| `reviewRounds` | 재설계 검수 회차(`redesign`이 아니면 빈 배열) |
| `carriedForward` | L3에서 이어받은 영향 없는 기반 기능 |

근거에는 계획을 복사하지 않는다. 검증기가 각 `testPlan`을 `approvedCommit`에서 직접 읽고, `approvedCommit`이 후보의 조상인지 확인한다. 기능 목록도 후보 SHA에서 직접 읽는다.

기록 커밋이 검수 SHA를 다시 바꾸는 문제를 피하려고, 최종 후보에 대한 JSON은 소스 밖에 저장한다. 태그 릴리스는 GitHub Release에 `development-evidence.<target>.<phase>.json`을 붙인다. 나중 단계 자산이 없으면 앞 단계 자산을 읽는다(`before-release` → `before-deploy` → `before-build`). 실기기 실행을 마친 뒤에는 그 실행을 더한 근거를 `before-release` 자산으로 올린다. 업로드 직전에는 자산을 다시 조회한다.

```text
development-evidence.google-play.before-build.json
development-evidence.google-play.before-release.json
development-evidence.app-store.before-build.json
development-evidence.app-store.before-release.json
```

```bash
# 최신 중앙 checkout에서 npm ci 후, 제품 저장소를 현재 디렉터리로 두고 로컬 JSON을 확인한다.
# 계획과 기준 태그 비교는 제품 저장소의 git으로 읽는다.
node /path/to/.github/scripts/release/verify-development-evidence.mjs \
  --file /path/to/actual-evidence.json --repo seorilabs/example \
  --sha <exact-final-sha> --target google-play --phase before-build

# GitHub Release 자산을 다시 읽고 검증한다. GH_TOKEN은 등록된 인증으로 공급한다.
# App Store·앱인토스 심사 제출 직전에는 --phase before-release로 실행한다.
node scripts/release/verify-development-evidence.mjs \
  --repo seorilabs/example --tag v1.2.3 --sha <exact-final-sha> \
  --target app-store --phase before-release
```

중앙 RN·Godot 마켓 workflow는 빌드·업로드 직전에, Play 승격 workflow는 승격 직전에 이 검증기를 호출한다. build-only는 빌드 전 검증만 한다. 태그 없는 build-only·웹은 `development-evidence`라는 전용 draft GitHub Release에 `development-evidence.<sourceSha>.<target>.<phase>.json`을 붙인다. 이는 제품 버전·공개 릴리스가 아닌 검수 보관함이다. 없으면 중단하며 허용용 빈 파일을 만들지 않는다. 공개 웹 배포는 명시 dispatch 또는 tag에서만 실행하고 push-to-main은 정적 검사만 한다. 로컬 빌드·외부 운영 도구·Xcode Cloud도 해당 단계의 검증을 반드시 실행한다. 제품별 Xcode Cloud post-clone/pre-upload 절차에서 동일 검증기를 호출한다.

검증기는 구조·후보 일치·계획 승인·하한·실행 범위·실행자 독립성·시간 순서·출시 범위를 확인한다. 주요 오류 코드는 다음과 같다.

| 오류 | 뜻 |
|---|---|
| `TEST_PLAN_UNAPPROVED <design>` | 계획이 승인 커밋에 없거나 승인 커밋이 후보의 조상이 아님 |
| `TEST_PLAN_INVALID <design> <사유>` | 계획 형식·등급·환경 규칙 위반 |
| `RUN_COVERAGE <env> <feature>` | 계획한 환경에서 그 기능의 통과 실행이 없음 |
| `TEST_LEVEL_BELOW_FLOOR <rule> <feature> <env>` | 바뀐 파일로 올라간 하한을 실행이 채우지 못했고 승인된 낮춤도 없음. 실행을 더하면 된다 |
| `RUN_EXPIRED`, `RUN_CANDIDATE_MISMATCH`, `EXECUTION_ORDER` | 168시간 초과, 다른 SHA, 시각 순서 오류 |
| `INDEPENDENT_RUN_REQUIRED <run>` | L2 실기기 실행 또는 L3 실행을 구현자가 함 |
| `TEST_LEVEL_BELOW_FLOOR platform <feature> <env>` / `platform-first …` | v2 플랫폼 경로 하한을 채우지 못함. `platform-first`는 첫 출시·새 플랫폼 기능이라 면제할 수 없음. 승인된 실제 SDK 개발 검수로 충족 가능 |
| `CI_RUN_UNVERIFIED`·`CI_RUN_MISMATCH`·`CI_RUN_NOT_SUCCESSFUL`·`CI_RUN_WORKFLOW`·`CI_RUN_KIND <run>` | CI 실행을 조회하지 못함·다른 저장소나 SHA·성공 아님·기능 목록의 E2E workflow가 아님·실기기 종류 |
| `RELEASE_NOT_AUTHORIZED` | 대상 마켓이 계획에 없음, 끝 지점이 `test-track`, Play 승격 비율이 승인한 `release.rollout`(생략 시 1)보다 큼; `release: null`인 개발 전용 후보는 모든 마켓 phase 차단 |
| `TEST_PLAN_DESIGN_MISMATCH <design>` | `testPlan`이 그 설계 문서와 같은 `docs/design/<id>/` 폴더에 있지 않음 |

첨부 내용만으로 실제 플레이나 사람 승인을 증명하지 않는다. 작성자와 독립 검수자는 승인·실행·접근 가능한 증거를 확인할 책임이 있다.

### v1 근거 과도기

`schemaVersion: 1` 근거(UI 3회 + 전체 Editor E2E)는 계약의 `legacyEvidence.acceptedUntil`(2026-10-22T00:00:00Z)까지 이전 규칙으로 검증한다. 출시 직전 단계에서는 v1 근거를 배포 직전 근거로 본다. 그 시각 이후에는 `EVIDENCE_V1_RETIRED`로 거절하며, 이후 v1 분기([development-evidence-v1.mjs](../../scripts/release/development-evidence-v1.mjs), [v1 schema](../../contracts/development-evidence-v1.schema.json))를 지우는 PR을 올린다.

## 자율 처리와 적용

자율 이슈 계약 v4는 승인 설계 없는 항목의 **설계 작성**과 **코드 구현**을 구분한다. 접수·근거 조사·설계 초안과 테스트 계획 초안은 가능하지만 구현 전 사람 검토를 기다린다. 해당 항목에 승인 대기를 기록하고 다른 미시도 적격 항목으로 진행한다. 승인된 범위에서는 TDD·계획한 실행·PR·CI·병합을 계속하고, 승인된 계획에 `release`가 있으면 그 끝 지점까지 진행한다. 계획한 환경을 그 실행 환경에서 쓸 수 없으면 정지 조건 3으로 멈춘다. 기존 lease, 우선순위, 동시 처리 1개를 유지한다. 기존 v2/v3 의미로 자동 구현하지 않는다.

신규 착수부터 적용한다. 이미 승인된 v1 설계로 진행 중인 작업은 테스트 계획을 더해 다시 승인받거나 과도기 동안 v1 근거로 마친다. 완료 이력에 새 승인이나 가짜 검수 기록을 소급 작성하지 않는다. 문서·정책만의 변경에 제품 실행 기록을 만들어 붙이지 않는다. 템플릿·검증기 테스트와 실제 제품 검수 완료는 별도로 보고한다.

릴리스 계약 v2는 public/private Apple 실행 경로와 필수 개발 검수 gate를 명시한다. 계약 ID `org-v1`은 기존 앱 manifest의 조직 정책 식별자로 유지하며, 읽는 계약의 schemaVersion은 2로 고정해 구분한다. 오래된 executor 필드의 의미를 조용히 재사용하지 않는다.

## 종료한 릴리스 예외 이력

Jomul의 고정 `v1.1.2` 태그 한 건에 대한 사람 승인 예외는 [중앙 PR #238](https://github.com/seorilabs/.github/pull/238)로 적용했다. Google Play·App Store 심사 접수 뒤 승인 목록과 전용 호환 경로를 제거했다. 기존 26 통과/4 차단, 미실행 E2E·장비 검수 생략 원본은 [jomul #200](https://github.com/seorilabs/jomul/issues/200)에 보존하며 검증 성공으로 바꾸지 않는다. 이 종료가 공개 출시를 승인하지는 않는다.

Reascend `v1.1.0`·`v1.1.1`과 Match Symbols iOS `v1.1.7`의 릴리스 예외는 등급제 적용([설계](../design/2026-10-14-test-levels/design.md) 순서 3)에서 검증기·grant·배포 workflow 입력을 함께 지웠다. 승인 설계는 `docs/design/2026-10-13-*`에, grant와 승인 receipt는 [삭제 직전 커밋](https://github.com/seorilabs/.github/tree/0963a4ed06d9129f633fc554d1b5de49a7600714/contracts/release-exceptions)에 남는다. 새 릴리스 예외 grant는 만들지 않고, 실기기 생략 같은 결정은 승인된 테스트 계획의 `floorOverrides`로 남긴다.

정상 검증의 Xcode Cloud `completed_at`과 `--after`는 실행 기록의 마지막 완료 시각과 빌드 전 완료 시각을 대조하는 일반 지원으로 유지한다.

## 첫 내부 TestFlight 검수 시점 예외

> 등급제에서는 iOS 실기기 실행을 TestFlight 빌드에서 하고 `before-release`에서 확인하므로, 계획에 `ios`를 두면 이 예외 없이 같은 순서로 진행한다. 이 장치는 Editor 근거를 v1으로 검사하므로 v1 근거가 끝나는 2026-10-22 이후 v1 분기와 함께 지운다([#249](https://github.com/seorilabs/.github/issues/249)). 새 grant는 그 전 첫 내부 TestFlight 한 건에만 쓴다.

Spiritgate 1.1.0의 기존 App Store profile에는 USB 설치 권한이 없어, [승인된 제안](../design/2026-10-14-spiritgate-internal-testflight/design.md)의 첫 내부 TestFlight 한 건에만 iPhone 기반 검수 시점을 설치 뒤로 옮긴다. `internalTestflightBootstrap`의 중앙 reviewed grant와 명시적 `--internal-testflight-bootstrap-id` 입력이 필요하다. 기본 정상 검증 실패를 자동 우회하지 않는다. 현재 등록 목록이 비어 있으면 모든 ID는 차단된다.

같은 후보·설정·28기능 inventory·원본 실패/부분/차단·독립 UI4·실제 Editor 전체 E2E·Android 기반 검수·원문 승인·168시간을 결속한다. 두 단계에서 검토된 중앙 소스와 최신 grant의 불변/철회, 실제 working tree, Apple의 app/product/workflow/수동 태그/첫 CI run을 확인한다. before-deploy는 기존 프로덕션 profile bytes와 실제 서명 앱·버전·SDK/privacy·같은 before-build 영수증이 필요하다. 원래 iPhone 미검수는 `deferred`, 제품 E2E는 `blocked`, 판단은 `human_exception`으로 보존한다.

Apple의 단일 archive action은 `INTERNAL_ONLY`여야 한다. 처리된 빌드 역시 `INTERNAL_ONLY`와 VALID, 같은 성공 CI run의 build 관계를 확인한 뒤 기존 내부 그룹에만 연결한다. 내부 예외 결과는 외부 TestFlight·App Review·공개 gate가 아니다. 실제 iPhone와 전체 기능 E2E·정상 중앙 검증을 완료한 뒤 공개용 새 archive를 진행한다. 등록은 실제 근거가 확정된 별도 reviewed grant를 요구하고, 새 후보·다른 source/run·만료·철회·조회 실패는 차단한다.

### 별도 승인된 UI5 기록

[승인된 UI5 설계](../design/2026-10-14-spiritgate-ui5/design.md)에 따라 첫 내부 grant의 `approvedUiRounds`는4 또는5이며 실제 기록 수와 같아야 한다. 5는 별도 승인·정확한 제안·후보·설정·원래 시점 예외 승인 hash를 중앙 검토본과 최신main에 결속한다. 기존 UI4 단일 승인 시각을 고치지 않고 `additionalIterationApprovals`에 새 승인을 보존한다. 승인전 실행·UI5 승인만으로 UI6 실행·168시간 연장·원본 실패 은폐를 허용하지 않으며, 등록 목록이 비어 있으면 실행은 여전히 차단된다.

### 별도 승인된 UI6 기록

[승인된 UI6 설계](../design/2026-10-15-spiritgate-ui6/design.md)는 정확한6회만 추가한다. 기존4/5회 경로의 후보·설정 비교는 유지한다. 6회는 `ui6ApprovalFile`·`ui6ApprovalSha256`와 정확한 제안, 현재 후보·설정에 별도로 결속한다. UI5 원문 승인·제안과 실제 `historicalUi5`의 source/configuration 자산 bytes를 보존해 과거 후보를 새 후보로 소급 변경하지 않는다. UI6 승인은 UI5 승인·source snapshot·configuration hash도 참조한다. 원래4/5회 승인 시각·실패·예산을 보존하고 4·5·6회 각각210분 상한, 최신 기능/UX·실제 Editor 전체 E2E·Android 기반4·기존168시간을 검사한다. UI7·실기기 면제·공개 예외는 추가하지 않는다. registry가 비어 있으면 검증기 지원만으로 실행은 허용되지 않는다.

### 별도 승인된 UI7·UI8과 과거 실패 결속

[UI7](../design/2026-10-15-spiritgate-ui7/design.md)·[UI8](../design/2026-10-15-spiritgate-ui8/design.md)은 각 별도 사람 승인과 정확한 제안·실제 source/configuration으로7·8회를 순서대로 허용한다. UI7 경로는 UI6 원본 실패5종, UI8 경로는 UI7 원래/수정 후보·설정과12개 원본 자산을 typed historicalUi7로 검증한다. UI7의 원문 null 승인·두 후보의 실패/미완료·원래180분/210분과 intent 기준 단1회30분 재확인·실제 종료를 유지하며 새 후보의 전체 PASS로 소급 합산하지 않는다. UI8의 별도 창 입력 진단1회15분은 본180분 안에 포함한다. 이전 회차와 마지막 검수·별도 E2E·Android·원래 만료·168시간·서명·iPhone·정상 v2/L3/공개 조건은 불변이며 registry가 비어 있으면 빌드를 허용하지 않는다. UI9나 시간 연장 승인은 포함하지 않는다.

### 별도 UI9 승인과 같은 회차의 입력 인계

[UI9 설계](../design/2026-10-16-spiritgate-ui9/design.md)는 과거 UI8의 차단·제품 실행0·원래 진단/본/총 시계·정확 PID 종료·manifest를 typed historicalUi8 원본8종에 결속한다. UI9의 최초 사전 승인과 같은 회차 도중의 별도 사람→독립 agent 입력 인계는 서로 다른 시각·원본 hash로 보존한다. 후보·QA 설정·시작·180/210분 마감·helper를 바꾸지 않으며 과거 사람 조작이나 저자 입력 확인을 독립 agent PASS로 소급하지 않는다. 별도 구현/리뷰 승인은 실행 승인 시각을 다시 쓰지 않는다.

현재 UI9는 원래 마감이 지난 미완료 이력이다. 이 코드 지원은 재개·UI10·시간 연장·실제 PASS·grant 등록을 허용하지 않는다. 이전 승인/실패·마지막 기능/UX·별도90분 E2E·Android 기반4·원래 만료/168시간·한 Cloud/업로드·정확 서명·iPhone·정상v2/L3/공개 조건과 빈 registry를 유지한다.

### 별도 UI10 승인과 만료된 UI9 이력

[UI10 설계](../design/2026-10-16-spiritgate-ui10/design.md)는 정확한10회 사전 승인과 별도 QA 후보·설정을 결속한다. typed historicalUi9는13개 원본과 불변 UI9 승인·입력 인계·늦은 구현 승인을 확인한다. UI9는 원래 cap을 넘긴 종료/최종보고·미완료·0PASS로 유지하며 마지막 실제 입력≤원래 cap, 기한 후 입력0/새Run0과 늦게까지 살아 있던 프로세스의 실제 소유 종료를 구분한다. 과거9의 completedAt은 실제 늦은 finalizedAt이며210분 안 완료로 바꾸지 않는다. 공통4~8과 마지막10의210분, 이전 실패/원문, 마지막 기능/UX·별도90분 E2E·Android 기반4·원래 만료/168시간·한 Cloud/업로드·정확 서명·iPhone·정상v2/L3/공개 조건은 불변이다. UI11·시간 연장·추가 진단은 승인하지 않았고 registry가 비어 있으면 여전히 빌드할 수 없다.

[Mac Editor 생략의 제한 결속](../design/2026-10-16-spiritgate-mac-editor-skip/design.md)은 사용자 직접 선택에 따라 막힌 Editor UI/E2E만 `skipped_incomplete`/`skipped`로 보존한다. 원래 UI10 승인·첫 실패·0PASS·원본6종·source/helper·소유 종료·두 manifest와 별도 Mac skip 승인/현재 후보를 모두 대조한 opt-in 첫 내부1.1.0에만 적용한다. 실제 같은 후보의 Android 기반4 전체 통과가 필요하며 결과 완료시각은 그 실제 Android 완료시각이다. dev 실행 통과나 제품 E2E 통과로 표시하지 않는다. 기존 v1/회차 승인과 실패는 불변이고 새로운 Editor 회차·가드 보정·만료 연장을 허용하지 않는다. 원래1후보/1Cloud/1업로드·168시간·v1 종료·정확 signed artifact·동일 build 검증, `nativeQaWaived=false`·`productE2eStatus=blocked`·`publicReleaseAllowed=false`와 iPhone/정상 v2·L3·독립 UI3·전체 native E2E/공개 검증은 유지한다. 실제 최종 증거 등록 전에는 registry가 비어 있어 빌드할 수 없다.


### 첫 내부 Spiritgate 1.1.0 실제 등록

[별도 승인된 최소 보정](../design/2026-10-16-spiritgate-failed-history-grant/design.md)으로 `spiritgate-1.1.0-first-internal` 한 grant를 `contracts/development-workflow.yaml`의 `grantRegistry`에 등록했다. 위 단계별 문서의 빈 registry 조건은 등록 전 상태를 설명한다. 이 등록은 고정 dc7ebea/v1.1.0과 원래 만료·한 Cloud/한 업로드, 기존 production 서명, 원문94개와 정정 집계 해시에 한정한다. 실패 UI6의 분리 창→내장 창 이력은 Mac skip 및 기능·UX 모두 failed일 때만 대조하며 원래 실패를 통과로 승격하지 않는다. 실제 reviewed main과 Cloud 실행·산출물·서명·TestFlight 상태 검사가 별도로 필요하고, iPhone·정상v2/L3·E2E·공개 검증은 면제되지 않는다. registry의 JSON 경로 배열은 기존 schema의 pattern/uniqueItems로 검증하며 schema를 확장하지 않는다.

### Lizard Tycoon 1.9.1 연결 이력

1.9.1 전용 예외의 승인과 범위는 [공개 연결 설계](../design/2026-10-19-lizard-191-public/design.md), 제거 조건과 결과는 [종료 설계](../design/2026-10-19-lizard-191-retire/design.md)에 보존한다. 활성 예외는 현재 grantRegistry를 따르며, 제거 전 원본은 [1feb44e의 grant](https://github.com/seorilabs/.github/blob/1feb44e448f289340bea89db1f0f74df846aecdc/contracts/historical-review-coverage/lizard-tycoon-1.9.1.json)에서 확인한다. 과거 실패와 근거 SHA를 정상 통과로 고치지 않는다.

[별도 승인된 App Store 연결](../design/2026-10-19-lizard-ios191/design.md)은 같은 제품 후보의 심사 한 건에만 적용한다. 원래 UI와 현재 CI의 세 과거 범위 오류만 허용하며, 별도 네이티브 문서를 정상 검증해 iOS 실제 SDK4개 미실행을 제출 전에 차단한다. 기존 Android 연결을 재활성화하지 않는다. 앱의 읽기 전용 토큰으로 실행하는 검증 전용 workflow는 마켓 빌드나 업로드를 수행하지 않는다.

[1.9.1 사용자 실행 대체 승인](../design/2026-10-19-lizard-ios191-owner/design.md)은 고정 App Store1.9.1(56) 제출 한 건에만 적용한다. 사용자 원문과 서버 SSV 및 지급, ASC 빌드, 제안과 승인 bytes를 reviewed grant에 결속한다. 사용자 기록을 일반 `runs`나 독립 검수 PASS로 만들지 않고 원래 native 오류와 `human_exception`을 보존한다. 추가 기기 사용과 만료 연장은 없다. 실제 제출 또는 원래 만료 뒤 전용 연결을 제거한다.

App Store1.9.1(56)의 실제 심사 접수 뒤 [종료 설계](../design/2026-10-19-lizard-ios191-retire/design.md)에 따라 iOS 전용 연결과 grant, 임시 CLI 입력을 제거했다. 위 연결 및 사용자 대체 승인 문단은 종료 이력이며 활성 예외가 아니다. 정상 native 원래 실패와 승인 대체 판정을 보존한다.

종료 전 iOS 승인 및 사용자 대체 grant 원본은 [24c559f의 고정 grant](https://github.com/seorilabs/.github/blob/24c559f39731b916404fab72e6c292555ab24e92/contracts/historical-review-coverage/lizard-tycoon-ios-1.9.1.json)에 보존한다.
