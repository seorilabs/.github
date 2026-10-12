# 개발 워크플로우

정본은 [development-workflow.yaml](../../contracts/development-workflow.yaml)이다. [승인 설계](../design/2026-10-08-development-workflow/design.md)는 결정 근거이며 이 문서가 실행 절차다. 공통 정책을 앱별 문서·스킬에 복제하지 않는다.

## 작업 정리와 설계 승인

`/plan`은 에이전트가 전체 작업·순서·의존성·영향 레포·미확정 사항·승인과 실행 자원을 정리하는 단계다. 구현 승인이나 상세 설계를 대신하지 않는다.

구현할 작업은 레포 `docs/design/YYYY-MM-DD-short-name/design.md`에 [설계 템플릿](templates/design.md)으로 작성한다. 흐름·구조·화면 예시를 우선하고, 목적·범위·근거, 사용자 흐름·상태, 책임·의존성, 데이터·인터페이스·실패, 품질, 대안·결정, 인수조건·테스트, 적용·운영·복구, 승인·추적을 포함한다. 작은 변경은 한 페이지로 축약하고 해당 없음은 이유를 기록한다.

사람이 정확한 설계 버전과 범위를 승인한 뒤 구현한다. 승인은 대화·이슈·PR 등 확인 가능한 근거와 문서 커밋으로 고정한다. 승인 범위 안의 다음 단계는 다시 묻지 않는다. 범위·제품 동작·데이터 규약·주요 구조·인수조건이 실질적으로 달라지면 변경 설계를 검토받는다. 사람 승인을 에이전트가 만들어내지 않는다.

승인 후 레포별 [실행 티켓](templates/execution-ticket.md)을 만들거나 충분한 기존 접수 이슈를 보강한다. Wiki는 날짜·승인 순서별 목록·요약과 최신 원본·승인 커밋·티켓·PR·검수 링크를 제공한다. 본문을 Wiki·Obsidian에 복사해 따로 수정하지 않는다. Obsidian에는 기획·검토·승인·회고와 정본 링크를 남긴다. Wiki를 사용할 수 없으면 `docs/design/README.md`로 같은 목록을 제공하고 Wiki 게시 완료라고 하지 않는다.

## 테스트 우선 구현

인수조건별로 `요구사항 때문에 실패하는 테스트 → 최소 구현 → 통과·관련 회귀 확인`을 수행한다. 테스트 문법·환경 오류는 실패 증거가 아니다. TDD를 적용할 수 없는 부분은 승인 설계에 이유와 대체 검증을 적고 결과를 남긴다. 에셋·플랫폼 연동 등의 예외가 전체 테스트나 실제 UI 실행의 면제가 되지 않는다. 별도 리팩토링은 기존 품의 규칙을 따른다.

조건 식별자를 설계·티켓·테스트·PR·검수에 연결한다. 실패·통과 로그와 미실행·차단을 구분한다.

## UI 검수 3회

각 회차 시작 전에 [회차 계획·보고서](templates/iteration.md)를 작성한다. 후보 SHA, 핵심 기능 전체, 기능·UX 항목과 기대 결과, 순서, 환경, 검수자 페르소나, 격리 데이터·저장 경로, 증거·통과 기준을 정한다.

`계획 → 실제 실행 → 독립 검수 → 범위 안의 수정 → 해당 문제 재확인 → 결과 기록`을 3회 수행한다. 매 회차의 "핵심 기능 전체"에서 [영향 없는 기반 기능](#영향-없는-기반-기능)은 이어받은 근거로 대신한다. 1회가 통과해도 2·3회를 수행한다. 계획을 소급 작성하거나 한 회차의 반복을 무제한 늘려 상한을 우회하지 않는다.

| 회차 | 매번 기능·UX 모두 검수하며 집중할 점 | 페르소나 |
|---|---|---|
| 1 | 핵심 기능 전체의 인수조건·입력·상태·결과·저장과 행동·결과의 이해 | 요구사항 검수자·처음 사용자 |
| 2 | 핵심 기능 재실행, 오류·취소·복구, 탐색·피드백·작은 화면·큰 글자·키보드·접근성 | 사용자 관점 검수자·필요 시 UX 전문가 |
| 3 | 핵심·기존 기능 연결, 회귀·재시작·저장 복구와 작업 전체의 자연스러운 완료 | 회귀·복구 검수자·반복 사용자 |

검수는 구현자와 **다른 리뷰 에이전트**가 실행 근거를 읽고 실제로 재현한다. 작성자의 역할 전환은 독립 검수가 아니다. 공유 기기는 순서를 조율하고 검수자가 코드·데이터를 임의 수정하지 않는다. 페르소나 검수는 실제 사용자 조사와 구분한다. UX 전문 역할은 새 탐색 구조·복잡한 입력·이해·접근성 문제나 판단 불일치가 있을 때 추가한다.

보고서는 `항목 → 관찰·증거 → 기능/UX 문제 → 사용자 영향 → 수정 제안 → 판정`을 남긴다. 발견·수정·재확인 이력을 지우지 않는다. 이전 회차의 실패 판정은 보존하고 해결·재검수 링크를 `resolutionEvidence`로 연결하며 최종 회차의 기능·UX는 통과해야 한다. 3회 뒤 미충족 조건·주요 결함·미검수 항목이 남으면 문제와 근거, 추가 회차·범위, 시간·비용, 검수자·환경, 중단 영향을 사람에게 품의한다. 승인 전에 4회차를 시작하지 않는다.

Godot·Unity는 Editor Play/Run, 웹은 개발 서버+실제 브라우저, 네이티브는 개발용 런타임+에뮬레이터/실기기를 사용한다. UI가 없는 서비스는 개발 환경 API·서비스 E2E를 사용한다. 스크린샷·코드 열람·headless 단위 테스트만으로 실제 실행을 대신하지 않는다. 사용자 저장·계정·데이터와 격리하고 초기화 전 저장 경로를 확인한다.

## 빌드 직전과 배포 직전 E2E

제품의 **구현 기능 전체** 목록을 소스 `docs/qa/feature-inventory.json`에 `schemaVersion: 1`과 `features: [{id, core, foundation?, paths?}]` 형식으로 유지하고([예시](templates/feature-inventory.example.json)) 각 기능을 하나 이상의 E2E 시나리오에 연결한다. 주요 작업은 시작→기능 사용→저장·화면 전환→오류·복구→종료·재실행을 이어서 실행한다. 새 변경만 확인하고 기존 기능을 빼지 않는다. 예외는 아래 영향 없는 기반 기능뿐이다.

최종 후보로 E2E를 실행해 결과를 남긴다. 소스 SHA·대상 마켓·실행 환경·설정 지문·격리 데이터·시나리오·증거를 고정한다. 같은 후보(소스 SHA·대상 마켓·설정 지문·기능 목록이 모두 같음)의 통과한 빌드 직전 결과는 배포 직전·승격 검증에 그대로 쓴다. 배포 직전 결과를 따로 남기지 않으면 검증기가 빌드 직전 결과를 읽는다. 배포 직전 결과가 빌드 직전 검증을 대신하지는 않는다. 코드·에셋·설정·의존성이 달라지면 기간과 상관없이 무효이고 다시 실행한다. 같은 후보라도 7일(168시간)이 지난 E2E는 서버·외부 SDK·도구 변화 확인을 위해 다시 실행한다. 네이티브 구매·광고·권한 등 해당 환경에서 확인할 수 없는 기능은 플랫폼 실기기 증거를 따로 요구하며 검증 부재를 성공으로 표시하지 않는다. 영향받은 기반 기능의 실기기 확인은 후보마다 1회(3회차 또는 최종 E2E)이며, 1·2회차는 개발 런타임의 테스트용 대체 구현으로 확인한다.

### 영향 없는 기반 기능

결제·광고·로그인·클라우드 저장·원격 설정·분석·권한처럼 실기기·외부 서비스가 필요한 기반 기능은 기능 목록에 `"foundation": true`와 `"paths"`(저장소 기준 glob)를 적는다. `paths`에는 그 기능의 코드·화면과 함께 SDK 버전이 바뀌는 의존성·네이티브 빌드 설정 파일을 넣는다. 제품 기능은 이어받지 않는다.

| 조건 | 판정 |
|---|---|
| 기준 SHA(그 기능을 실제로 실행해 통과한 SHA)부터 후보까지 바뀐 파일(이름 변경 전후 포함)이 `paths`와 겹치지 않음, 기준 SHA의 같은 기능 정의와 `paths`가 같음, 실제 실행 후 30일 이내 | UI 회차·최종 E2E에서 생략하고 근거의 `carriedForward`에 기록 |
| 경로가 겹침, 기준이 후보의 조상이 아님, 변경 파일 300개 이상, 기준 커밋·기능 목록을 읽을 수 없음, 정의 변경, 30일 초과 | 다시 실행 |

`carriedForward` 항목은 `featureId`, `baselineSha`, `verifiedAt`, `evidence`를 가진다. 이어받은 근거를 다시 이어받을 때도 기준 SHA·실행 시각·증거는 원래 실제 실행 값을 유지한다. 마켓별 근거이므로 같은 마켓의 실행만 이어받는다. 영향 판정은 검증기가 하며 에이전트 판단으로 목록을 줄이지 않는다. `paths`를 좁히는 변경은 기준 정의와 달라져 다시 실행하게 된다.

3회 검수와 최종 E2E는 별도다. 최종 E2E에서 추가 기능·UX 회차가 필요해지면 사람의 추가 진행 승인을 받는다. 필수 시나리오 미실행·차단·실패는 빌드·배포 차단이다. 산출물·기기 QA·마켓 문구·심사·공개·live 확인은 기존 독립 단계를 따른다.

## 기계 검증과 증거 보존

[development-evidence.schema.json](../../contracts/development-evidence.schema.json)의 예제는 [development-evidence.example.json](templates/development-evidence.example.json)이다. 이 예제는 가상 데이터이며 제품 검수 증거가 아니다. 보고서 본문은 `docs/qa/<design-id>/`, 대용량 로그·영상은 제품 정책에 맞는 보존 위치에 두고 URL·해시·환경을 연결한다. 만료·삭제된 링크를 살아 있는 증거로 표시하지 않는다.

기록 커밋이 검수 SHA를 다시 바꾸는 문제를 피하려고, 최종 후보에 대한 JSON은 소스 밖에 저장한다. 태그 릴리스는 GitHub Release에 다음 자산을 붙인다. 마켓과 단계별 파일을 따로 사용하며 업로드 직전에는 자산을 다시 조회한다.

```text
development-evidence.apps-in-toss.before-build.json
development-evidence.apps-in-toss.before-deploy.json
development-evidence.google-play.before-build.json
development-evidence.google-play.before-deploy.json
development-evidence.app-store.before-build.json
development-evidence.app-store.before-deploy.json
```

실제 파일은 예제에서 이름만 바꾸지 말고 실행 결과로 작성한다. `approvedCommit`은 설계 승인 커밋이며 `sourceSha`는 최종 후보다. 3회 보고서는 각각 당시 후보 SHA를 보존한다. E2E의 `sourceSha`는 배포 후보와 정확히 일치해야 한다. 설정 지문은 비밀값을 포함하지 않는 실제 실행 설정 식별자의 SHA-256이다. 실행자가 현재 설정과 대조하고, 지문을 알고 있는 호출자는 검증기에 `--configuration-fingerprint`를 전달한다.

```bash
# 최신 중앙 checkout에서 npm ci 후 로컬 JSON을 확인한다.
node scripts/release/verify-development-evidence.mjs \
  --file /path/to/actual-evidence.json --repo seorilabs/example \
  --sha <exact-final-sha> --target apps-in-toss --phase before-build

# GitHub Release 자산을 다시 읽고 검증한다. GH_TOKEN은 등록된 인증으로 공급한다.
node scripts/release/verify-development-evidence.mjs \
  --repo seorilabs/example --tag v1.2.3 --sha <exact-final-sha> \
  --target apps-in-toss --phase before-deploy
```

중앙 RN·Godot 마켓 workflow는 빌드·업로드 직전에 이 검증기를 호출한다. build-only는 빌드 전 검증만 한다. 태그 없는 build-only·웹은 `development-evidence`라는 전용 draft GitHub Release에 `development-evidence.<sourceSha>.<target>.<phase>.json`을 붙인다. 이는 제품 버전·공개 릴리스가 아닌 검수 보관함이다. 없으면 중단하며 허용용 빈 파일을 만들지 않는다. 공개 웹 배포는 명시 dispatch 또는 tag에서만 실행하고 push-to-main은 정적 검사만 한다. 로컬 빌드·외부 운영 도구·Xcode Cloud도 해당 단계의 검증을 반드시 실행한다. 중앙 workflow를 거치지 않는 경로는 실행자가 검증을 생략하지 못하며, 제품별 Xcode Cloud post-clone/pre-upload 절차에서 동일 검증기를 호출한다. 이 중앙 변경을 모든 앱의 Xcode Cloud 훅 설치 완료로 표현하지 않는다.

검증기는 후보 SHA의 기능 목록을 GitHub contents API에서 직접 읽어 보고서가 목록 자체를 줄였는지도 확인한다. 목록이 없으면 통과시키지 않는다. 이어받은 기반 기능은 GitHub compare API와 기준 SHA의 기능 목록으로, 로컬 `--file` 검증은 현재 저장소의 git으로 같은 판정을 한다. 검증기는 구조·후보 일치·회차·독립 검수자·시간 순서·기능 누락·통과 상태를 확인한다. 첨부 내용만으로 실제 플레이나 사람 승인을 증명하지 않는다. 작성자와 독립 검수자는 승인·실행·접근 가능한 증거를 확인할 책임이 있다.

## 명시적으로 승인한 한 릴리스의 예외

[release-exception.schema.json](../../contracts/release-exception.schema.json)은 [일반 v1 PASS 근거](../../contracts/development-evidence.schema.json)와 별도다. 예외는 E2E 통과가 아니라 위험을 사람이 수용한 출시 판단이며 `decisionStatus:human_exception`, `productE2eStatus:blocked`를 출력한다. `--release-exception-id`를 명시하지 않으면 기존 검증만 수행한다. 빈 근거·자동 fallback·환경변수로 검증기를 끄는 경로는 없다.

현재 검토된 grant는 `seorilabs/reascend`의 `v1.1.0` 하나다. [승인 설계](../design/2026-10-13-reascend-release-exception/design.md), [grant](../../contracts/release-exceptions/reascend-1.1.0.json), [공개용 원문 승인](../../contracts/release-exceptions/reascend-1.1.0.approval.json), [원래 26기능 판정](../../contracts/release-exceptions/reascend-1.1.0.observations.json)을 결속한다. local home 경로·대화 식별자는 공개 receipt에 넣지 않고 private 원본의 해시만 연결한다. 향후 grant 추가는 조직 계약 변경과 사람 승인·필수 코드 리뷰를 거쳐야 한다. runtime manifest의 `approver:human` 같은 자기 선언은 승인으로 인정하지 않는다.

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

태그 발급 전 검사에는 `releaseBinding:null`을 쓴다. 이는 `preflight_ready`이며 빌드·업로드를 허가하지 않는다. source가 이미 원격에서 조회돼야 하고 현재 main의 grant도 조회 가능해야 한다.

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

before-build에는 아직 없는 artifact를 요구하지 않는다. before-deploy에는 Android의 공식 release binding, artifact receipt, 실제 AAB 파일이 필요하다. iOS는 변경하지 않은 고정 helper `53c0819ec0976a48c7e8302234bcfc408f0a1e0b`가 만든 binding, 실제 서명 앱 Info.plist와 `CI_BUILD_NUMBER`를 대조한다. iOS archive의 CI 번호와 공식 태그 receipt의 encoded 번호는 구별한다. 이 provenance는 grant와 판정 리포트에 기록한다.

```bash
# 실제 before-build: preflight 인자 없이 Release 자산을 읽는다.
node scripts/release/verify-development-evidence.mjs \
  --repo seorilabs/reascend --tag v1.1.0 --sha <final-sha> \
  --target google-play --phase before-build \
  --release-exception-id reascend-1.1.0 --configuration-fingerprint <market-sha256> \
  --verifier-sha <reviewed-central-sha> --report /path/to/before-build.json

# Android before-deploy에는 기존 공식 도구로 생성·검증한 산출물을 추가한다.
# 위 공통 인자 + --phase before-deploy
# --release-binding /path/to/release-binding.json
# --artifact-receipt /path/to/release-artifact-receipt.txt --artifact-file /path/to/verified.aab

# iOS before-deploy에는 고정 helper의 실제 binding과 서명 앱 plist를 추가한다.
# 위 공통 인자 + --target app-store --phase before-deploy
# --release-binding /path/to/.seori-release-binding.json
# --artifact-file /path/to/signed.app/Info.plist --xcode-build-number <actual-CI_BUILD_NUMBER>
```

검증기는 상태·원래 판정·승인 해시·후보·설정·태그·artifact를 JSON으로 보존한다. 예외에서 기존 ‘개발 검수 근거 통과’ 문구를 쓰지 않는다. Android caller와 Xcode hook/trigger는 계속 중앙 검증기를 실행한다. 예외 만료·철회·후보/설정 변경·해당 릴리스 종료 시 manifest를 닫고 다시 사용하지 않는다. 중앙 일반 지원은 검토된 계약으로 유지하며 임시 우회를 제거할 때까지 방치하는 방식은 사용하지 않는다.

서명, 상품·가격·지급·한도, 판매자·유료 계약·정산, 국가 정책·연령/확률 공시, 마켓 심사·승인·공개·실서비스 조회는 면제하지 않는다. 사용자용 마켓 문구와 별도로 릴리스의 운영 위험 기록에 미확인 항목과 판정 리포트를 남긴다.

## 자율 처리와 적용

자율 이슈 계약 v4는 승인 설계 없는 항목의 **설계 작성**과 **코드 구현**을 구분한다. 접수·근거 조사·설계 초안은 가능하지만 구현 전 사람 검토를 기다린다. 해당 항목에 승인 대기를 기록하고 다른 미시도 적격 항목으로 진행한다. 승인된 범위에서는 TDD·3회 검수·PR·CI·병합을 계속한다. 기존 lease, 우선순위, 동시 처리 1개와 외부 배포 승인 경계를 유지한다. 기존 v2/v3 의미로 자동 구현하지 않는다.

신규 착수부터 적용한다. 구현 중인 작업은 현재 설계와 남은 작업을 정리해 추가 코드 작성 전에 검토받는다. 완료 이력에 새 승인이나 가짜 검수 기록을 소급 작성하지 않는다. 문서·정책만의 변경에 제품 UI 검수 3회를 만들어 붙이지 않는다. 템플릿·검증기 테스트와 실제 제품 검수 완료는 별도로 보고한다.

릴리스 계약 v2는 public/private Apple 실행 경로와 필수 개발 검수 gate를 명시한다. 계약 ID `org-v1`은 기존 앱 manifest의 조직 정책 식별자로 유지하며, 읽는 계약의 schemaVersion은 2로 고정해 구분한다. 오래된 executor 필드의 의미를 조용히 재사용하지 않는다.
