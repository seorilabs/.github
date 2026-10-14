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
| **L3** | 바뀐 기능 + 전체 회귀 | 개발 환경 / Android / iOS / 둘 다 중 설계에서 선택 | 모든 실행을 다른 에이전트가 함. 새 화면·UI 개편이면 3회 검수 | SDK·엔진·의존성 업그레이드, 저장 형식 변경, 공통 구조 변경 |

| `test-plan.json` 필드 | 규칙 |
|---|---|
| `level` | L1은 `environments: ["dev"]`만. L2는 `android`·`ios` 중 하나 이상(`dev` 선택). L3는 비어 있지 않은 아무 조합 |
| `baseline` | 대상 마켓의 현재 공개 버전 태그 또는 전체 회귀를 통과한 마지막 릴리스 태그. 후보의 조상이어야 한다. 첫 출시는 `null`이며 L3만 허용 |
| `changedFeatures` | 기능 목록의 ID. 새 기능은 기능 목록에 먼저 추가 |
| `environments` | `dev`·`android`·`ios`. 적은 환경마다 범위 안의 기능을 모두 실행 |
| `redesign` | 새 화면·UI 개편이면 `true`. L3이어야 하며 [재설계 검수 3회](#재설계-ui-검수-3회)를 한다 |
| `foundationRerun` | L3에서만 `true`. 기반 기능도 이어받지 않고 다시 실행 |
| `floorOverrides` | 아래 하한을 낮춘 항목과 사유. `{rule: "foundation", featureId, reason}` 또는 `{rule: "regression", reason}` |
| `release` | `markets`(출시할 마켓), `until`(`test-track` / `review-submitted` / `public`, 생략하면 `public`), `rollout`(Play 단계적 출시 비율, 선택) |

한 후보에 승인 설계가 여러 개 묶이면 등급은 가장 높은 값, 기능·환경·마켓은 합집합, 끝 지점은 가장 이른 값을 쓴다. 하한 낮춤은 묶인 모든 계획에 같은 항목이 있을 때만 인정한다.

### 검증기가 계산하는 하한

검증기는 계획의 `baseline`부터 후보까지 바뀐 파일로 최소 범위를 계산한다. 계획이 하한보다 낮으면, 승인된 계획에 해당 `floorOverrides`가 있을 때만 통과한다. 근거 파일이나 승인 뒤 커밋에 적은 낮춤은 인정하지 않는다.

| 바뀐 파일 | 하한 | 낮추기 |
|---|---|---|
| 기능의 `paths` | 그 기능을 계획한 환경에서 실행 대상에 추가 | 해당 없음 |
| 기반 기능(`foundation: true`)의 `paths`, 또는 `changedFeatures`의 기반 기능 | 그 기능을 **검증 중인 마켓 플랫폼의 실기기**에서 실행(L2) | `{rule: "foundation", featureId}` |
| `regressionPaths`(기능 목록에 없으면 [중앙 기본값](../../contracts/development-workflow.yaml)의 엔진·export·플러그인·네이티브 빌드 설정·잠금 파일) | 계획한 환경마다 전체 회귀(L3) | `{rule: "regression"}` |
| 비교 불가(기준이 후보의 조상이 아님, 300개 이상, 조회 불가) 또는 `baseline: null` | 전체 회귀(L3) | `{rule: "regression"}`. 첫 출시는 낮출 수 없음 |
| `redesign: true` | L3·3회 검수 | 낮출 수 없음 |

플랫폼 연결: `google-play`→Android, `app-store`→iOS, `apps-in-toss`→Android 또는 iOS 중 하나, `web`·`service`→실기기 없음.

착수 뒤 예상하지 못한 경로를 건드려 하한이 올라가면 **사람에게 묻지 않고** 그 실행을 더한다. 계획 파일은 바꾸지 않는다. 검증기는 실제 실행이 하한을 채우면 통과시킨다. 반대로 계획보다 테스트를 줄이려면 설계를 다시 승인받는다.

### 기능 목록

제품의 구현 기능 전체를 소스 `docs/qa/feature-inventory.json`에 `schemaVersion: 1`로 유지한다([예시](templates/feature-inventory.example.json)). 모든 기능에 선택 `paths`(저장소 기준 glob)를, 최상위에 선택 `regressionPaths`를 적는다. 기반 기능은 `"foundation": true`와 `paths`가 필수다. `paths`가 없는 기능은 하한 계산에서 자동으로 추가되지 않으므로 바뀐 기능을 `changedFeatures`에 직접 적는다.

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

## 실행과 단계별 검사

계획한 환경마다 범위 안의 기능을 실제로 실행하고 [실행 기록](templates/run.md)을 남긴다. 주요 작업은 시작→기능 사용→저장·화면 전환→오류·복구→종료·재실행을 이어서 실행한다. 스크린샷·코드 열람·headless 단위 테스트만으로 실제 실행을 대신하지 않는다. 사용자 저장·계정·데이터와 격리하고 초기화 전 저장 경로를 확인한다.

| 환경 | 실행 종류(`runs[].kind`) | 방법 |
|---|---|---|
| 개발 환경(`dev`) | `godot-editor`, `unity-editor`, `web-browser`, `native-development`, `service-runtime` | Editor Play/Run, 개발 서버+실제 브라우저, 개발용 런타임, 서비스 API E2E |
| Android(`android`) | `android-device` | adb 실기기. 테스트 채널 빌드(Play 내부 테스트 등) 또는 같은 SHA 로컬 빌드 |
| iOS(`ios`) | `ios-device` | 실기기. TestFlight 빌드 또는 같은 SHA 로컬 빌드 |

모든 실행은 후보 SHA와 정확히 같아야 하고 168시간 안이어야 한다. 실기기 실행은 `target`(설치한 빌드의 마켓)·`device`·`build`를 적고, 검증 중인 마켓의 실행이면 설정 지문을 적는다. 개발 환경 실행은 테스트용 대체 구현을 쓰므로 마켓 설정 지문과 대조하지 않는다. 필수 시나리오의 미실행·차단·실패는 통과가 아니다.

| 단계 | 호출 위치 | 요구하는 실행 |
|---|---|---|
| `before-build`, `before-deploy` | 중앙 빌드·업로드 workflow, Xcode Cloud 훅 | 계획의 개발 환경 실행. 실기기 실행은 아직 없어도 된다 |
| `before-release` | Play production 승격 workflow, App Store·앱인토스 심사 제출 직전 로컬 실행 | 계획의 모든 실행(실기기 포함)과 하한, 출시 범위(`release.markets`에 대상 마켓, `until`이 `test-track`이 아님) |
| `web`·`service`의 `before-deploy` | 공개 배포 workflow | 모든 실행과 출시 범위(테스트 채널이 없다) |

Play의 테스트 트랙 사이 승격은 `before-deploy`, production 승격은 `before-release`로 검사한다. App Store·앱인토스 심사 제출은 중앙 workflow가 하지 않으므로 실행자가 제출 직전에 `--phase before-release`를 실행한다.

### 영향 없는 기반 기능

결제·광고·로그인·클라우드 저장·원격 설정·분석·권한처럼 실기기·외부 서비스가 필요한 기반 기능은 L3 전체 회귀에서 이어받을 수 있다. 바뀐 기능(`changedFeatures`·경로가 겹친 기능)은 이어받지 않는다. `foundationRerun: true`이면 이어받지 않는다. 제품 기능은 이어받지 않는다.

| 조건 | 판정 |
|---|---|
| 기준 SHA(그 기능을 실제로 실행해 통과한 SHA)부터 후보까지 바뀐 파일(이름 변경 전후 포함)이 `paths`와 겹치지 않음, 기준 SHA의 같은 기능 정의와 `paths`가 같음, 실제 실행 후 30일 이내 | 회귀·재설계 회차에서 생략하고 근거의 `carriedForward`에 기록 |
| 경로가 겹침, 기준이 후보의 조상이 아님, 변경 파일 300개 이상, 기준 커밋·기능 목록을 읽을 수 없음, 정의 변경, 30일 초과 | 다시 실행 |

`carriedForward` 항목은 `featureId`, `baselineSha`, `verifiedAt`, `evidence`를 가진다. 이어받은 근거를 다시 이어받을 때도 기준 SHA·실행 시각·증거는 원래 실제 실행 값을 유지한다. 영향 판정은 검증기가 하며 에이전트 판단으로 목록을 줄이지 않는다. `paths`를 좁히는 변경은 기준 정의와 달라져 다시 실행하게 된다.

## 승인 뒤 진행과 정지 조건

승인된 계획의 `release`가 배포 요청이다. 구현→PR·CI·리뷰·병합→계획한 실행→태그·빌드·테스트 채널 업로드→실기기 실행→심사 제출·승격→승인 후 공개·live 확인을 `until`까지 이어서 진행한다. 단계마다 사람에게 다시 묻지 않는다. 테스트를 **더 하는** 쪽(하한 상향, 환경 추가)도 묻지 않는다. 빌드·업로드·심사·승인·공개·live 확인은 서로 다른 상태로 기록한다.

아래 경우에만 멈추고 사람에게 보고한다.

1. 테스트 실패를 승인 범위 안에서 고칠 수 없다(제품 동작·데이터 규약·구조·인수조건이 바뀌어야 함).
2. 검증기·required check·ruleset이 막는다. 우회하지 않는다.
3. 계획한 환경을 쓸 수 없다(예: iOS 실기기 없음). 계획을 낮추려면 다시 승인받는다.
4. 마켓 거절이 승인 범위 밖의 수정을 요구한다. 문구·메타데이터 같은 범위 안 수정은 고쳐서 다시 제출한다.
5. 새 화면·UI 개편 3회 뒤에도 미해결이다.
6. 기존 개별 승인 대상: 결제 상품·가격·정산, 자격증명 생성·교체, 데이터 삭제·복구, 보안 민감 변경의 교차 리뷰 불가, 지원팀 연락.

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
| `RELEASE_NOT_AUTHORIZED` | 대상 마켓이 계획에 없거나 끝 지점이 `test-track` |

첨부 내용만으로 실제 플레이나 사람 승인을 증명하지 않는다. 작성자와 독립 검수자는 승인·실행·접근 가능한 증거를 확인할 책임이 있다.

### v1 근거 과도기

`schemaVersion: 1` 근거(UI 3회 + 전체 Editor E2E)는 계약의 `legacyEvidence.acceptedUntil`(2026-10-22T00:00:00Z)까지 이전 규칙으로 검증한다. 출시 직전 단계에서는 v1 근거를 배포 직전 근거로 본다. 그 시각 이후에는 `EVIDENCE_V1_RETIRED`로 거절하며, 이후 v1 분기([development-evidence-v1.mjs](../../scripts/release/development-evidence-v1.mjs), [v1 schema](../../contracts/development-evidence-v1.schema.json))를 지우는 PR을 올린다.

## 명시적으로 승인한 한 릴리스의 예외

> 이 절은 [변경 등급별 테스트 계획](../design/2026-10-14-test-levels/design.md)의 순서 3에서 예외 장치와 함께 지운다. 새 grant는 추가하지 않는다. 실기기 생략 같은 결정은 승인된 테스트 계획의 `floorOverrides`로 남긴다.

[release-exception.schema.json](../../contracts/release-exception.schema.json)은 [일반 v1 PASS 근거](../../contracts/development-evidence-v1.schema.json)와 별도다. 예외는 E2E 통과가 아니라 위험을 사람이 수용한 출시 판단이며 `decisionStatus:human_exception`, `productE2eStatus:blocked`를 출력한다. `--release-exception-id`를 명시하지 않으면 기존 검증만 수행한다. 빈 근거·자동 fallback·환경변수로 검증기를 끄는 경로는 없다.

[grant schema](../../contracts/release-exception-grant.schema.json)는 필수값·알 수 없는 필드·168시간 상한을 검사한다. `development-workflow` v1의 `releaseExceptions`는 선택적 확장이므로 기존 v1 문서를 거절하지 않는다. 현재 중앙 정본에는 registry를 유지한다.

현재 검토된 grant는 `seorilabs/reascend`의 양쪽 `v1.1.0`과 iOS만의 `v1.1.1`이다. [1.1.0 승인 설계](../design/2026-10-13-reascend-release-exception/design.md), [grant](../../contracts/release-exceptions/reascend-1.1.0.json), [공개용 원문 승인](../../contracts/release-exceptions/reascend-1.1.0.approval.json), [원래 26기능 판정](../../contracts/release-exceptions/reascend-1.1.0.observations.json)을 결속한다. [iOS 1.1.1 설계](../design/2026-10-13-reascend-ios-111-exception/design.md)와 [전용 grant](../../contracts/release-exceptions/reascend-1.1.1.json)는 macOS 임시 경로 오류의 최소 소스 수정만 허용하며, 기존 판정·위험·168시간 만료 시각을 보존한다. Android 1.1.0 태그·심사와 grant는 유지한다. local home 경로·대화 식별자는 공개 receipt에 넣지 않고 private 원본의 해시만 연결한다. 향후 grant 추가는 조직 계약 변경과 사람 승인·필수 코드 리뷰를 거쳐야 한다. runtime manifest의 `approver:human` 같은 자기 선언은 승인으로 인정하지 않는다.

마켓별 최종 source SHA, 비밀값 없는 실제 설정 SHA-256, 검증기 SHA, 기준 제품 tree와 26기능 inventory, 원문 승인/설계/관측 판정 해시, 최대 168시간을 확인한다. 실제 전체 E2E를 실행하지 않았다면 실행 시각을 만들거나 승인 시각을 E2E 완료 시각으로 쓰지 않는다. 기존 scoped PASS/partial/unknown/blocked를 보존하며, 실제 통과한 기반 기능의 30일 승계와 이번 사람 예외를 혼동하지 않는다.

기준부터 후보까지 `.github/workflows/deploy-google-play.yml`·`xcode-cloud/ci_scripts/verify_development_evidence.sh` 두 파일만 바뀔 수 있다. Git recursive tree 전체를 읽어 두 파일 외 blob/모드/submodule의 동일성과 inventory 원문 해시를 비교한다. truncated 조회는 실패다. 두 파일 변경으로 새 SHA가 생기면 그 SHA에 manifest를 결속하며, 이전 UI8를 새 후보의 전체 PASS로 바꾸지 않는다.

다음 자산을 같은 `v1.1.0` GitHub Release에 붙인다. GitHub Release 공개 상태와 마켓 공개는 별개다. draft 자산의 조회에는 push 권한이 필요할 수 있으며 조회 불가면 중단한다.

```text
release-exception.google-play.json
release-exception.app-store.json
release-exception.approval.json
release-risk-notes.md
release-exception.original-ui-review-8.md
release-exception.original-final-e2e-result.json
```

[manifest 예제](templates/release-exception.example.json)의 반복 숫자는 placeholder이며 실제 실행값으로 교체한다. `sourceSha`, `verifierSha`, 마켓별 `configurationFingerprint`, `productTreeSha256`은 실행자가 계산한다. 제품 tree digest는 허용 두 파일을 제외한 recursive tree의 non-tree 항목을 path의 Unicode 순서로 정렬한 `[{path,type,mode,sha}]`를 `JSON.stringify`한 SHA-256이다. [위험 기록 예제](templates/release-risk-notes.example.md)의 정확한 bytes를 해시해 `riskNotesSha256`에 넣는다. 관측 판정과 승인 bytes는 중앙 원본과 같아야 한다.

두 원본 보고서는 기존 파일의 정확한 bytes를 위 자산명으로 첨부한다. 각 실제 phase에서 다운로드해 검토된 관측 기록의 해시와 비교한다. 누락·변조는 중단하며 이전 실행 시각을 갱신하지 않는다. 비공개 원본의 사용자 경로는 공개 중앙 저장소의 테스트 fixture에 복사하지 않는다.

태그 발급 전 검사에는 `releaseBinding:null`을 쓴다. `CI`, `GITHUB_ACTIONS`, `CI_XCODE_CLOUD` 실행에서는 이 preflight를 거절한다. 이는 `preflight_ready`이며 빌드·업로드를 허가하지 않는다. source가 이미 원격에서 조회돼야 하고 현재 main의 grant도 조회 가능해야 한다.

```bash
node scripts/release/verify-development-evidence.mjs \
  --repo seorilabs/reascend --tag v1.1.0 --sha <final-sha> \
  --target google-play --phase before-build \
  --release-exception-id reascend-1.1.0 --configuration-fingerprint <market-sha256> \
  --verifier-sha <reviewed-central-sha> --preflight true \
  --exception-file /path/to/actual-manifest.json --risk-notes-file /path/to/actual-risk-notes.md \
  --original-evidence-dir /path/to/original-report-assets \
  --report /path/to/preflight.json
```

공식 태그 발급 뒤 `releaseBinding`에 실제 annotated tag object SHA와 태그 message 원문의 SHA-256을 채운다. 실제 phase는 Release 자산을 다시 읽고 공식 receipt의 source/version/authority를 검증한다. 모든 phase에서 최신 중앙 main의 같은 grant를 조회해 철회·승인 핵심값 변경을 확인한다. 조회 불가나 `revoked:true`면 고정 pin의 검증기도 실패한다. 중앙의 무관 커밋만 바뀌면 grant 내용이 같으므로 이 조회는 막지 않는다.

before-build에는 아직 없는 artifact를 요구하지 않는다. before-deploy에는 Android의 공식 release binding, artifact receipt, 실제 AAB 파일이 필요하다. iOS는 변경하지 않은 고정 helper `53c0819ec0976a48c7e8302234bcfc408f0a1e0b`가 만든 binding, 실제 서명 앱 Info.plist와 `CI_BUILD_NUMBER`를 대조한다. CLI에 넘긴 번호도 실제 CI 환경의 같은 값이어야 한다. iOS archive의 CI 번호와 공식 태그 receipt의 encoded 번호는 구별한다. 이 provenance는 grant와 판정 리포트에 `declared-protected-consumer-pin`으로 기록한다. 소비자 코드는 제품 tree 검사로 보호하지만 기존 임시 helper는 phase 전에 삭제되므로 해당 phase에서 helper bytes를 다시 읽었다고 주장하지 않는다. iOS artifact 해시는 실제 Info.plist bytes이며 `kind:xcode-app-info-plist`로 범위를 표시한다. 전체 archive 해시가 아니다. 기존 post-xcodebuild의 서명·archive·bundle 검사도 계속 요구한다.

```bash
# 실제 before-build: preflight 인자 없이 Release 자산을 읽는다.
node scripts/release/verify-development-evidence.mjs \
  --repo seorilabs/reascend --tag v1.1.0 --sha <final-sha> \
  --target google-play --phase before-build \
  --release-exception-id reascend-1.1.0 --configuration-fingerprint <market-sha256> \
  --verifier-sha <reviewed-central-sha> --app-repository /path/to/exact-app-checkout \
  --report /path/to/before-build.json

# Android before-deploy에는 기존 공식 도구로 생성·검증한 산출물을 추가한다.
# 위 공통 인자 + --phase before-deploy
# --release-binding /path/to/release-binding.json
# --artifact-receipt /path/to/release-artifact-receipt.txt --artifact-file /path/to/verified.aab

# iOS before-deploy에는 고정 helper의 실제 binding과 서명 앱 plist를 추가한다.
# 위 공통 인자 + --target app-store --phase before-deploy
# --release-binding /path/to/.seori-release-binding.json
# --artifact-file /path/to/signed.app/Info.plist --xcode-build-number <actual-CI_BUILD_NUMBER>
```

검토된 grant에는 마켓별 실제 설정 지문과 등록 Firebase bytes, 생성 runtime, `build.env`·generator, AdMob 입력·주입 후 `project.godot`/`data/ad_units.json` 해시를 고정한다. 실제 CI phase는 `--app-repository`의 파일과 실제 workflow/CI 환경에서 package·internal track·completed status·upload·Godot·export preset·build/prepare/audit script·analytics·Xcode scheme/project/tag를 읽어 대조한다. 등록 설정의 내용은 출력하지 않고 해시만 남긴다.

before-build는 실제 준비 스크립트보다 앞에 있다. 보호된 generator와 등록 Firebase CI bytes를 격리 디렉터리에서 실행한 예상 runtime을 확인하고 `generated-from-ci-input`으로 기록한다. 이미 소비된 runtime이라고 하지 않는다. before-deploy는 실제 생성된 runtime·Firebase 사본과 주입 후 광고 파일을 읽어 `actual-runtime-file`로 기록한다. 운영 서버 설정은 중앙 CI의 권한 밖이므로 검토된 snapshot과 실행자의 빌드 전후 직접 재조회가 필요하다. 중앙 해시 대조를 fresh 운영 조회라고 표시하지 않는다.

검증기의 40hex 입력도 단독으로 신뢰하지 않는다. Git checkout은 실제 HEAD와 직접 사용 tracked bytes를 대조하며, `.git` 없는 Xcode codeload는 같은 GitHub revision의 검증기·authority·schema·registry·grant·승인·관측·package lock 원문과 로컬 bytes를 독립 대조한다. 해당 SHA가 현재 main의 ancestor여야 한다. npm CI로 lock의 의존성을 설치하며 파일 증명은 `verifierProof`에 남긴다. Android 예외는 `release_verifier_sha`를 명시해 같은 구현에 authority checkout을 고정하고, 정상 경로는 계속 main을 사용한다. 최신 main의 grant 철회는 pin과 별개로 매 phase 조회한다.

Xcode 기동 요청은 실제 CI의 입력을 갖지 않는다. trigger 내부 `verifyXcodeLaunchRequest`는 공통 Release/source/승인 검증 후 ASC에서 선택한 provider·product·workflow·repository·TAG ref를 확인한다. `scope:xcode-launch-request`, `actualCiVerification:pending-ci-hook`, `executionConfiguration:null`을 출력하며 실제 CI 통과로 취급하지 않는다. 외부 CLI의 skip flag는 없고, `CI_XCODE_CLOUD=TRUE`인 실제 hook은 이 경계를 사용할 수 없다. 실제 hook의 before-build/before-deploy는 `scope:actual-ci-phase`의 전체 입력 검사를 실행한다. 거절도 요청된 JSON 보고서에 기록하고 원래 오류를 다시 던진다.

Android Actions 보고서·산출물 보존 기간은 기존 3일을 유지한다. 실제 internal 업로드가 성공한 같은 job이 AAB·공식 binding·receipt·두 실제 CI 판정·주입 설정 해시를 `promotion-evidence.zip` 하나로 묶고, 명세와 원본 ZIP의 SHA256을 원격 job 로그 한 줄에 기록한다. 실행자는 Actions 다운로드 묶음 안의 **이 원본 inner ZIP**을 재압축하지 않고 private Release 운영 자산에 복사한다. 원격 성공 run/attempt/job와 로그를 읽지 못하면 Release 자기선언이나 로컬 CI 환경 복제로 대체하지 않는다.

기존 `promote-google-play`는 일반 PASS 계약을 유지한다. 이번 수동 Console/API 공개 승격 직전에는 별도 `verify-google-play-promotion.mjs`를 실행한다. 이 경계는 `promotion-recheck`/`reused-successful-ci`이며 실제 CI phase를 새로 실행했다고 기록하지 않는다. 같은 후보·마켓 설정·26개 원래 판정·168시간 예외·태그·최신 중앙 철회를 다시 검증하고, 원격 CI의 reusable workflow SHA가 현재 main의 ancestor인지와 검토 pin의 workflow bytes가 같은지 확인한다. workflow SHA와 verifier checkout pin은 서로 다른 역할이며 값이 달라도 bytes가 같아야 한다. 원격 job 로그의 원본 ZIP·명세 해시와 보존한 실제 bytes, 두 CI 보고서의 실제 입력/주입 해시, 같은 공식 AAB/receipt를 결속한 뒤 **기존 read edit의 Play internal track GET**으로 `completed`인 같은 versionCode를 확인한다. 토큰과 edit ID는 환경 변수에서만 읽고 출력하지 않는다. edit 발급/삭제·승격 자체는 검증기의 기능이 아니다. 운영 서버 설정의 fresh readback과 동일 projection 확인은 기존 등록 운영 identity를 쓰는 실행자 경계로 계속 별도 보존한다.

Android dispatch는 `--ref v1.1.0`을 명시한다. 입력의 `release_tag`만 지정하고 실행 ref를 main에 두면 main 이동 후 run의 `head_sha`와 고정 후보가 달라져 승격 경계가 거절한다.

```sh
gh workflow run deploy-google-play.yml --repo seorilabs/reascend --ref v1.1.0 \
  -f release_tag=v1.1.0 -f release_exception_id=reascend-1.1.0 \
  -f release_verifier_sha="$RELEASE_VERIFIER_SHA" \
  -f configuration_fingerprint="$GOOGLE_PLAY_CONFIGURATION_FINGERPRINT" \
  -f upload=true -f track=internal -f release_status=completed
```

실행자는 Actions가 보관한 inner ZIP을 `release-exception.google-play.promotion-evidence.zip`으로 Release에 보존하고 로컬로 다시 받아 다음 명령을 공개 승격 직전에 실행한다. `GH_TOKEN`, `GOOGLE_PLAY_ACCESS_TOKEN`, `GOOGLE_PLAY_READ_EDIT_ID`는 기존 identity의 환경 변수로 준비하고 인자·로그에 값을 넣지 않는다. 성공 보고서를 Release 운영 자산에 보존한 뒤 같은 versionCode만 승격한다.

```sh
node scripts/release/verify-google-play-promotion.mjs \
  --repo seorilabs/reascend --tag v1.1.0 --sha "$RELEASE_SOURCE_SHA" \
  --release-exception-id reascend-1.1.0 --verifier-sha "$RELEASE_VERIFIER_SHA" \
  --configuration-fingerprint "$GOOGLE_PLAY_CONFIGURATION_FINGERPRINT" \
  --ci-run-id "$SUCCESSFUL_RUN_ID" --ci-run-attempt "$SUCCESSFUL_RUN_ATTEMPT" \
  --evidence-bundle release-exception.google-play.promotion-evidence.zip \
  --report promotion-recheck.json
```

검증기는 상태·원래 판정·승인 해시·후보·설정·태그·artifact를 JSON으로 보존한다. 예외에서 기존 ‘개발 검수 근거 통과’ 문구를 쓰지 않는다. Android caller와 Xcode hook/trigger는 계속 중앙 검증기를 실행한다. 예외 만료·철회·후보/설정 변경·해당 릴리스 종료 시 manifest를 닫고 다시 사용하지 않는다. 중앙 일반 지원은 검토된 계약으로 유지하며 임시 우회를 제거할 때까지 방치하는 방식은 사용하지 않는다.

서명, 상품·가격·지급·한도, 판매자·유료 계약·정산, 국가 정책·연령/확률 공시, 마켓 심사·승인·공개·실서비스 조회는 면제하지 않는다. 사용자용 마켓 문구와 별도로 릴리스의 운영 위험 기록에 미확인 항목과 판정 리포트를 남긴다.

## 자율 처리와 적용

자율 이슈 계약 v4는 승인 설계 없는 항목의 **설계 작성**과 **코드 구현**을 구분한다. 접수·근거 조사·설계 초안과 테스트 계획 초안은 가능하지만 구현 전 사람 검토를 기다린다. 해당 항목에 승인 대기를 기록하고 다른 미시도 적격 항목으로 진행한다. 승인된 범위에서는 TDD·계획한 실행·PR·CI·병합을 계속하고, 승인된 계획에 `release`가 있으면 그 끝 지점까지 진행한다. 계획한 환경을 그 실행 환경에서 쓸 수 없으면 정지 조건 3으로 멈춘다. 기존 lease, 우선순위, 동시 처리 1개를 유지한다. 기존 v2/v3 의미로 자동 구현하지 않는다.

신규 착수부터 적용한다. 이미 승인된 v1 설계로 진행 중인 작업은 테스트 계획을 더해 다시 승인받거나 과도기 동안 v1 근거로 마친다. 완료 이력에 새 승인이나 가짜 검수 기록을 소급 작성하지 않는다. 문서·정책만의 변경에 제품 실행 기록을 만들어 붙이지 않는다. 템플릿·검증기 테스트와 실제 제품 검수 완료는 별도로 보고한다.

릴리스 계약 v2는 public/private Apple 실행 경로와 필수 개발 검수 gate를 명시한다. 계약 ID `org-v1`은 기존 앱 manifest의 조직 정책 식별자로 유지하며, 읽는 계약의 schemaVersion은 2로 고정해 구분한다. 오래된 executor 필드의 의미를 조용히 재사용하지 않는다.

## 기존 고정 태그의 Jomul v1.1.2 예외 이력

Jomul의 고정 `v1.1.2` 태그 한 건에 대한 사람 승인 예외는 [중앙 PR #238](https://github.com/seorilabs/.github/pull/238)로 적용했다. Google Play·App Store 심사 접수 뒤 승인 목록과 전용 호환 경로를 제거했다. 기존 26 통과/4 차단, 미실행 E2E·장비 검수 생략 원본은 [jomul #200](https://github.com/seorilabs/jomul/issues/200)에 보존하며 검증 성공으로 바꾸지 않는다. 이 종료가 공개 출시를 승인하지는 않는다.

정상 검증의 Xcode Cloud `completed_at`과 `--after`는 실행 기록의 마지막 완료 시각과 빌드 전 완료 시각을 대조하는 일반 지원으로 유지한다. 기존 Reascend grant 검증·철회·산출물 검증은 그대로 적용한다.

## 첫 내부 TestFlight 검수 시점 예외

> 등급제에서는 iOS 실기기 실행을 TestFlight 빌드에서 하고 `before-release`에서 확인하므로, 계획에 `ios`를 두면 이 예외 없이 같은 순서로 진행한다. 이 절과 장치는 예외 장치 삭제(설계 [2026-10-14-test-levels](../design/2026-10-14-test-levels/design.md) 순서 3) 때 함께 정리 대상으로 검토한다.

Spiritgate 1.1.0의 기존 App Store profile에는 USB 설치 권한이 없어, [승인된 제안](../design/2026-10-14-spiritgate-internal-testflight/design.md)의 첫 내부 TestFlight 한 건에만 iPhone 기반 검수 시점을 설치 뒤로 옮긴다. `internalTestflightBootstrap`의 중앙 reviewed grant와 명시적 `--internal-testflight-bootstrap-id` 입력이 필요하다. 기본 정상 검증 실패를 자동 우회하지 않는다. 현재 등록 목록이 비어 있으면 모든 ID는 차단된다.

같은 후보·설정·28기능 inventory·원본 실패/부분/차단·독립 UI4·실제 Editor 전체 E2E·Android 기반 검수·원문 승인·168시간을 결속한다. 두 단계에서 검토된 중앙 소스와 최신 grant의 불변/철회, 실제 working tree, Apple의 app/product/workflow/수동 태그/첫 CI run을 확인한다. before-deploy는 기존 프로덕션 profile bytes와 실제 서명 앱·버전·SDK/privacy·같은 before-build 영수증이 필요하다. 원래 iPhone 미검수는 `deferred`, 제품 E2E는 `blocked`, 판단은 `human_exception`으로 보존한다.

Apple의 단일 archive action은 `INTERNAL_ONLY`여야 한다. 처리된 빌드 역시 `INTERNAL_ONLY`와 VALID, 같은 성공 CI run의 build 관계를 확인한 뒤 기존 내부 그룹에만 연결한다. 내부 예외 결과는 외부 TestFlight·App Review·공개 gate가 아니다. 실제 iPhone와 전체 기능 E2E·정상 중앙 검증을 완료한 뒤 공개용 새 archive를 진행한다. 등록은 실제 근거가 확정된 별도 reviewed grant를 요구하고, 새 후보·다른 source/run·만료·철회·조회 실패는 차단한다.
