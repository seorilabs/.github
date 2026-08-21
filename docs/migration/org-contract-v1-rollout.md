# Seorilabs Org Contract v1 롤아웃

> 상태: 실행 시작안
> 기준일: 2026-08-21
> 중앙 정책 ID: `org-v1`
> 적용 범위: `seorilabs` 조직의 active 앱·게임 저장소, `.github`, `platform`, Backoffice, 로컬 agent 설정
> 비범위: 프로덕션 마켓 업로드, 심사 제출, 공개 배포, 자격증명 회전·폐기

## 1. 목표와 불변식

Org Contract v1은 앱마다 복사된 정책을 줄이고 다음 책임 경계를 고정한다.

| 영역 | 정본 | 소비 방식 |
| --- | --- | --- |
| 조직 개발·테스트·리뷰·릴리스 계약 | `seorilabs/.github/contracts/` | schema/CLI/CI로 검증 |
| 앱의 식별자·stack·market·명령 선언 | 각 repo의 `.seorilabs/app.yaml` | 계약 검증기와 Backoffice가 읽음 |
| 공통 RN/TS 기능 | `platform`의 버전된 package | 정확한 버전 + lockfile |
| 공통 Godot 기능 | `platform`의 버전된 release asset | vendor + source/version/checksum |
| 자격증명 | `~/.config/seorilabs` catalog | logical ID와 명시적 consumer 연결 |
| agent 실행 절차 | `~/.agent` | 전역 원칙 + 작업별 skill + 조직 contract lock·routing. 조직 정책 전문은 복사하지 않음 |
| 운영 상태 | GitHub 원본, Backoffice mirror | GitHub webhook/reconcile을 통한 단방향 반영 |

다음 원칙은 단계와 무관하게 유지한다.

- 공통 라이브러리는 기본적으로 Git submodule로 배포하지 않는다.
- 앱 repo에는 조직 정책 전문을 복사하지 않고 앱 고유 선언·명령·예외만 둔다.
- reusable workflow는 immutable commit SHA로 고정하고 secret은 필요한 이름만 전달한다.
- Backoffice DB는 GitHub 상태의 mirror다. mirror 직접 입력이나 mirror에서 GitHub로의 역기록을 만들지 않는다.
- 구현, CI, artifact, upload, processing, device QA, review, approval, deployment, public availability를 서로 다른 gate로 기록한다.
- 이 롤아웃에서 production upload, 심사 제출, 공개 배포를 실행하지 않는다. 그러한 작업은 고정된 release candidate와 별도 사용자 승인으로 시작하는 release 작업이다.

## 2. 근거 상태와 P0 재검증

숫자와 저장소 상태는 변할 수 있으므로 확인된 사실과 실행 직전 재검증 대상을 구분한다.

### 2.1 선행 기준선에서 확인된 사실

- 2026-08-21 선행 감사는 조직 repo 37개, active 36개를 기준선으로 사용했다.
- 12개 repo 표본에서 표준 caller 7/12, 표준 테스트 alias 3종 8/12, repo `AGENTS.md` 9/12, PR template 6/12, CODEOWNERS 0/12로 확인됐다.
- reusable workflow ref 표본 60개 중 53개가 `@main`을 사용했다. 더 넓은 credential/caller 감사에서도 `@main` 또는 `secrets: inherit` 의존이 다수 확인됐다.
- 이 기반 변경 전 `.github/docs/ci-cd/org-cicd-release-system.md`와 `.github/workflows/README.md`는 `@main`, `secrets: inherit`, Backoffice 문서 mirror를 과도기 표준으로 서술했다. 이 변경은 README를 새 목표 계약으로 전환하고 기존 설계 문서는 legacy 기준선으로 표시한다.
- Backoffice에는 `.github`와 같은 이름의 `docs/ci-cd/org-cicd-release-system.md`가 존재한다.
- Backoffice seed 경로는 `.seorilabs/app.yaml` 하나가 아니라 마켓별 config, Granite config, 표준 workflow 파일 존재 여부를 각각 파싱해 registry 값을 계산한다.
- 로컬 `~/.agent`는 공통 skill 원본과 플랫폼별 link를 함께 관리하지만 플랫폼별 설치 목록이 일치하지 않고 사용자 변경이 있는 dirty worktree다. 현재 `seorilabs-org-release-pipeline` skill은 `@main`, `secrets: inherit`, GitHub macOS를 표준으로 두고 `seori-pr-workflow` skill은 Copilot 미수신 병합 조건이 새 review contract와 달라 P2 동기화 전까지 drift 상태다.
- 선행 credential catalog 감사 스냅샷은 71개 entry, error 0건, warning 8건이었다. 이 수치는 삭제 근거가 아니며 logical ID·consumer·provider identity를 다시 확인해야 한다.

### 2.2 P0에서 반드시 다시 확인할 항목

- GitHub API로 active/archived/template repo 목록과 각 default branch를 다시 고정한다.
- 각 대상 repo의 최신 `origin/main` SHA, open PR, dirty 로컬 checkout, required checks와 ruleset을 기록한다.
- 전체 reusable caller의 실제 ref, `secrets: inherit`, secret/variable/environment 이름, workflow consumer를 다시 센다.
- 앱별 package name, bundle ID, AIT app ID, Firebase project, market target을 provider/API 또는 현재 config와 대조한다.
- `~/.agent`와 Claude/Codex/Gemini install 대상의 실제 link·hash·미커밋 변경을 보존한 채 다시 검사한다.
- credential catalog warning, local/BeeStation backup, restore check, public identity, GitHub/Kubernetes 실행 복제본의 consumer를 값 노출 없이 다시 확인한다.
- Backoffice production이 읽는 registry source, webhook delivery, reconcile 결과와 마지막 readback 시각을 확인한다.

P0 재검증이 끝나기 전에는 선행 감사의 개수를 조직 전체 완료율이나 삭제 승인 근거로 사용하지 않는다.

## 3. 공통 gate 모델

각 작업과 Backoffice 화면은 아래 상태를 합치지 않는다.

| Gate | 완료 증거 | 다음 상태로 오인하면 안 되는 것 |
| --- | --- | --- |
| Source | PR의 최종 commit SHA와 변경 계약 | merge 예정 상태 |
| Contract | schema와 repo-contract 검사 성공 | 앱 기능 테스트 성공 |
| CI | required static checks 성공 | artifact 생성 또는 배포 |
| Artifact | 고정 SHA에서 생성된 AAB/IPA/`.ait`/web artifact와 checksum | market upload |
| Upload | provider API가 반환한 upload 식별자 | processing 완료 |
| Processing | provider processing 상태 readback | device QA |
| Device QA | 고정 후보의 실기기 증거 | 심사 승인 |
| Review | 제출과 review 상태 readback | 승인 또는 공개 |
| Approval | provider 승인 상태 readback | production deployment |
| Deployment | track/release 배포 상태 readback | 사용자에게 공개됨 |
| Public | 실제 listing/version 및 live smoke readback | 단순 workflow 성공 |

Org Contract v1 이관의 자동 검증 상한은 기본적으로 `Artifact`다. 외부 sandbox가 명확히 분리된 검증을 제외하고 `Upload` 이후 gate는 실행하지 않는다.

## 4. GitHub와 Backoffice 경계

Backoffice의 유일한 쓰기 경로는 다음과 같다.

```text
운영자 또는 agent
  -> GitHub API write
  -> GitHub event 또는 workflow
  -> webhook
  -> Backoffice mirror upsert
  -> GitHub/API와 mirror readback 비교
```

- GitHub Issue, PR, Release, workflow가 원본이다.
- Backoffice는 lifecycle과 계약 준수 상태를 표시하되 GitHub 원본을 덮어쓰지 않는다.
- webhook 누락은 reconcile로 복구한다. mirror DB 직접 INSERT/UPDATE로 성공 상태를 만들지 않는다.
- workflow 성공은 CI 또는 upload 경로의 증거일 뿐, review·approval·public 상태는 각 provider readback으로만 올린다.
- 새 `.seorilabs/app.yaml`을 반영할 때는 GitHub 기본 브랜치의 고정 SHA를 읽고 schema 검증 후 mirror한다.
- 기존 parser를 제거하기 전, 새 contract 기반 registry 값과 기존 값의 shadow 비교 및 production readback을 통과해야 한다.

## 5. 파일럿 프로필

특정 repo 이름은 P0에서 live 상태와 owner를 확인한 뒤 확정한다. 네 프로필을 하나씩 건너뛰지 않고 검증한다.

| 프로필 | 검증할 차이 | 최소 gate |
| --- | --- | --- |
| RN 3마켓 | monorepo 경로, package SDK, Android/iOS/AIT manifest | contract + test alias + static CI + build-only artifact |
| Godot 3마켓 | GDScript vendor metadata, export preset, web wrapper | contract + headless check + checksum + build-only artifact |
| Legacy RN | 기존 경로와 명령을 표준 alias로 감싸는 migration | 새 template과 동등한 contract 결과, 임시 호환층 제거 조건 |
| Legacy Godot | 이전 SDK 복사본과 비표준 export hook 이관 | 고정 engine 검사, export hook parity, vendor freshness |

파일럿 선택 조건은 다음과 같다.

- owner와 rollback 담당자가 명확하다.
- 최신 default branch와 open migration PR을 확인했다.
- 사용자 dirty checkout을 건드리지 않고 최신 `origin/main`의 격리 worktree에서 작업할 수 있다.
- production upload 없이 build-only artifact까지 검증할 수 있다.
- 최소 하나의 active market과 Backoffice mirror consumer가 있어 실제 계약 경계를 검증할 수 있다.

각 파일럿은 독립 PR로 수행하고, 한 프로필의 예외를 다른 프로필에 복사하지 않는다. 반복되는 예외만 중앙 profile 또는 ADR 후보로 승격한다.

## 6. 단계별 실행 계획

### P0 — 기준선 고정과 위험 격리

작업:

- active repo와 owner를 stack/market/lifecycle/profile별로 inventory한다.
- workflow ref, secret 전달, test alias, CODEOWNERS, PR template, agent instruction을 machine-readable snapshot으로 만든다.
- credential은 logical ID, scope, public identity, consumer, backup 상태만 기록한다.
- 중복 문서·설정·SDK·parser·credential을 삭제하지 않고 P5 후보 ID로 등록한다.
- production write 권한이 필요한 명령은 rollout 검증 경로에서 분리한다.

완료 gate:

- 모든 대상 repo에 owner, profile, default SHA, contract 상태, 예외 또는 blocker가 있다.
- P5 후보마다 최소 owner와 현재 consumer 확인 계획이 있다.
- 비밀값, custom token, signing material이 snapshot·로그·PR에 없다.

### P1 — 중앙 계약과 검증기

작업:

- 중앙 정책 ID `org-v1`과 `schemaVersion: 1`의 app schema 및 test/review/release/credential-consumer/market 계약을 추가한다.
- `.seorilabs/app.yaml` 예시와 repo-contract CLI를 만든다.
- schema 자체의 positive/negative fixture와 backward-compatibility 정책을 테스트한다.
- `contracts/agent-policy.yaml`에 `~/.agent`가 정책 전문 대신 contract version/ref/checksum과 skill routing만 두는 배포 계약을 정의한다.
- Backoffice는 새 manifest를 읽되 기존 parser와 shadow compare하는 호환 기간을 둔다.

완료 gate:

- `.github` 자체 CI에서 schema, fixtures, CLI, 문서 link 검사가 통과한다.
- invalid manifest가 구체적인 경로와 원인으로 실패한다.
- 대표 fixture가 contract version과 immutable source ref를 재현한다.
- Backoffice DB나 provider에 production write가 발생하지 않는다.

### P2 — 공통 배포 수단

작업:

- reusable workflow와 composite action을 release commit SHA로 고정할 수 있게 한다.
- 각 reusable workflow에 named `workflow_call.secrets`를 먼저 선언한 뒤 caller별 explicit secret mapping과 최소 permission 계약을 만든다. P1 시점의 deploy workflow는 아직 `secrets: inherit` consumer가 있어 목표 caller 예시를 적용하지 않는다.
- RN/TS SDK는 실제 consumer별 package와 lockfile importer를 선언하는 versioned package, Godot SDK는 release asset + source/version/checksum 방식으로 배포한다.
- RN/Godot template, standard test alias, market manifest·asset validator, agent install verifier를 제공한다.
- build-only workflow와 deploy workflow의 이름·environment·권한을 명확히 분리한다.
- active caller를 고정 SHA로 옮긴 뒤 `global-versions.yaml`과 다른 중앙 action major를 검증된 버전으로 정렬한다.
- Apple archive와 App Store upload의 표준 실행 환경은 Xcode Cloud로 두되, 기존 GitHub macOS workflow는 consumer와 rollback을 확인한 뒤에만 비활성화·삭제하고 production build run은 시작하지 않는다.
- `~/.agent`의 두 drift skill을 새 release/review contract로 갱신하고 contract lock·checksum·idempotent install verifier를 배포한다. dirty 변경을 덮거나 일괄 relink하지 않는다.

완료 gate:

- 새 template repo가 별도 정책 복사 없이 contract와 static CI를 통과한다.
- package 또는 vendor artifact가 정확한 version/checksum으로 재현된다.
- build-only 경로가 provider API, production environment, deploy credential을 사용하지 않음을 테스트한다.
- reusable caller 예시는 `@main`과 `secrets: inherit` 없이 동작한다.
- GitHub App Store legacy workflow의 신규 consumer가 0건이고 기존 consumer마다 Xcode Cloud 이관 또는 승인된 예외가 있다.
- agent install verifier가 contract hash와 release/review skill 의미의 일치를 확인한다.

### P3 — 네 프로필 파일럿

작업:

- 파일럿 repo마다 `.seorilabs/app.yaml`, standard alias, pinned caller, explicit secret mapping을 작은 PR로 이관한다.
- RN SDK update와 Godot vendor update가 자동 PR로 제안되고 수동 review 가능하게 한다.
- Backoffice에서 기존 parser 결과와 v1 contract 결과를 shadow compare한다.
- agent가 전역 원칙, repo `AGENTS.md`, app manifest, 관련 skill 순서로 읽는 preflight를 검증한다.

완료 gate:

- 네 프로필 모두 contract, repo test, static CI, build-only artifact 검증을 통과한다.
- 기존과 신규 registry 결과의 차이가 없거나 승인된 migration 사유로 설명된다.
- rollback PR 또는 이전 caller ref 복구 절차가 검증된다.
- 마켓 upload, 심사 제출, 공개 배포는 0건이다.
- 파일럿을 실행한 agent에서 stale `@main`·`secrets: inherit`·GitHub macOS·Copilot 미수신 병합 지시가 발견되지 않는다.

### P4 — 조직 확산과 강제

작업:

- 파일럿 결과를 고정한 뒤 profile별 wave로 active repo를 이관한다.
- CODEOWNERS, 한국어 PR template, required checks와 contract status를 표준화한다.
- ruleset은 Evaluate 모드에서 관찰한 뒤 owner 승인으로 Active 전환한다.
- Backoffice에는 contract version, SDK version, workflow SHA, gate별 evidence를 mirror한다.
- GitHub Project와 Backoffice의 단일 Verification/Release 표현을 implementation, CI, artifact, upload, processing, device QA, review, approval, deployment, public evidence로 분리한다.
- 비준수 repo는 silent fallback 대신 명시적 exception ID와 만료일을 갖게 한다.

완료 gate:

- active repo 전부가 conforming, approved exception, blocked 중 하나로 분류된다.
- conforming repo의 기본 브랜치 caller에서 floating org workflow ref와 secret 전체 상속이 없다.
- GitHub event에서 Backoffice mirror/readback까지 재현 가능한 증거가 있다.
- 자동 강제 전후 false positive와 rollback 경로가 확인된다.
- 이 단계 역시 production upload, 심사 제출, 공개 배포를 실행하지 않는다.

### P5 — 정리와 삭제

작업:

- `p5-cleanup-inventory.md`의 후보만 작은 cleanup PR 단위로 처리한다.
- 중앙 정본과 동일한 release/review/credential 문서 복제본, 대체된 caller·script·SDK·parser·agent reference를 정리한다.
- credential과 SealedSecret은 일반 파일 정리와 분리하고 provider identity, backup/restore, live consumer, 명시 승인을 모두 요구한다.
- 삭제 뒤 observation window와 rollback evidence를 남긴다.

완료 gate:

- 각 삭제 기록에 owner, consumer 검색, replacement, live readback, backup/restore 해당 여부, 승인, rollback이 있다.
- 중앙 정본과 앱 고유 문서의 경계가 contract 검사로 유지된다.
- 미확인 consumer가 있는 파일, key, Secret, SealedSecret 삭제는 0건이다.
- 사용자 변경이 있는 dirty `~/.agent`나 앱 checkout을 자동 정리하지 않는다.

## 7. 변경 단위와 중단 조건

모든 이관은 다음 단위로 진행한다.

1. 최신 remote default branch와 대상 확인
2. 격리 worktree와 작은 migration PR
3. contract/static/build-only 검증
4. owner review와 required checks
5. Backoffice mirror/readback
6. observation
7. 별도 cleanup PR

다음 상황에서는 해당 repo 또는 후보를 blocked로 남기고 진행하지 않는다.

- owner 또는 consumer를 확정할 수 없다.
- app identity나 credential scope가 서로 충돌한다.
- backup 또는 임시 복원 검증이 실패한다.
- 새 contract와 live provider/Backoffice readback 결과가 다르다.
- 검증이 secret 값 출력이나 production upload를 요구한다.
- ruleset 또는 권한을 우회해야만 통과할 수 있다.

## 8. 완료 정의

Org Contract v1 롤아웃은 다음 조건이 모두 성립할 때 완료다.

- 모든 active repo에 유효한 v1 manifest와 owner가 있다.
- 표준 test alias, CODEOWNERS, PR template, required contract check가 적용됐다.
- org reusable caller는 immutable SHA와 explicit secret mapping을 사용한다.
- RN package와 Godot vendor의 source/version/checksum을 추적할 수 있다.
- market metadata가 중앙 schema를 통과하되 앱 고유 자산은 앱 repo에 남는다.
- Backoffice는 GitHub에서 단방향으로 mirror하고 모든 release gate를 분리 표시한다.
- agent 설치 상태와 contract lock을 자동 검증할 수 있다.
- P5 후보는 검증 후 제거됐거나 owner·사유·만료일이 있는 보류 상태다.
- production upload, submission, approval, deployment, public 상태는 별도 release 작업의 증거로만 변경된다.
