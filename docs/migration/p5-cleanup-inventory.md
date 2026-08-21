# P5 정리·삭제 후보 인벤토리

> 상태: 후보 등록 전용
> 기준일: 2026-08-21
> 주의: 이 문서는 삭제 승인이 아니며 현재 파일, workflow, credential, Secret을 삭제하지 않는다.

## 1. 목적

P5는 파일 수 자체를 줄이는 단계가 아니라 중앙 정본이 안정된 뒤 중복 source of truth와 대체된 compatibility 경로를 제거하는 단계다. 후보 등록과 실제 삭제를 분리하고, 확인되지 않은 consumer 또는 사용자 변경을 보존한다.

## 2. 근거 수준

후보마다 다음 세 상태를 사용한다.

- `확인`: 현재 파일·코드·선행 감사에서 직접 확인한 사실
- `P0 재검증`: live GitHub/API/cluster/provider 상태가 변할 수 있어 실행 직전 다시 확인할 사실
- `삭제 가능`: 아래 공통 gate를 모두 통과하고 명시적 승인을 받은 상태

선행 감사의 repo/호출 개수는 기준선일 뿐 삭제 gate를 대체하지 않는다.

## 3. 공통 삭제 gate

모든 후보는 다음 항목을 기록해야 한다. 해당 없음도 근거와 함께 명시한다.

| Gate | 요구 증거 |
| --- | --- |
| Owner | 정본과 삭제 대상의 책임 팀 또는 repo owner |
| Consumer | repo code search, GitHub code/API search, workflow, Backoffice registry, agent install, cluster/provider consumer 목록 |
| Replacement | 새 contract/package/workflow/parser가 기본 브랜치에 반영된 commit SHA |
| Required checks | replacement의 계약·테스트·build-only 검증 성공 |
| Live readback | GitHub, Backoffice, provider, cluster 중 해당 시스템이 replacement를 실제로 읽는 증거 |
| Backup/restore | 복구가 필요한 항목의 백업 위치와 임시 복원 검증 결과 |
| Approval | owner 승인. credential·Secret·외부 상태는 사용자 명시 승인도 필요 |
| Rollback | 삭제 commit revert만으로 충분한지, 별도 restore가 필요한지와 담당자 |
| Observation | 삭제 후 정한 관찰 기간과 오류·누락 확인 결과 |

gate 하나라도 충족하지 못하면 `보류`로 남긴다. 여러 범주의 후보를 한 PR에서 같이 삭제하지 않는다.

## 4. 후보 목록

### C-01 — 중복 release 설계 문서

| 항목 | 내용 |
| --- | --- |
| Owner | DevEx / `.github`, Backoffice owner |
| 정본 후보 | `.github/contracts/`, `.github/docs/`의 최신 계약 문서 |
| 삭제 후보 | `seorilabs-backoffice/docs/ci-cd/org-cicd-release-system.md` 및 중앙 정본과 동일한 repo-local 복제본 |
| 확인 | 선행 기준선에서 `.github/docs/ci-cd/org-cicd-release-system.md`와 Backoffice의 같은 경로·파일명이 함께 존재했고 `.github/workflows/README.md`도 Backoffice 문서를 운영 mirror로 지칭했다. P1 기반 변경은 중앙 README의 mirror 지칭을 제거하지만 Backoffice 복제본의 consumer는 아직 확인하지 않았다. |
| P0 재검증 | 두 파일 hash/diff, inbound link, Backoffice build·운영 runbook consumer, 검색 엔진/agent reference |
| 삭제 gate | Backoffice가 중앙 문서를 링크하거나 contract version을 mirror하고, docs link check와 production UI/readback이 통과한 뒤 별도 cleanup PR |
| Rollback | 삭제 commit revert. 중앙 문서를 수정하는 rollback과 섞지 않는다. |

중앙 문서 자체도 내용을 최신 v1 계약으로 바꾼 뒤, 동일 설명이 여러 파일에 남으면 한 곳만 정본으로 유지한다. 먼저 오래된 내용을 정본으로 승격한 뒤 복제본만 지우는 순서를 금지한다.

### C-02 — `@main` reusable workflow caller

| 항목 | 내용 |
| --- | --- |
| Owner | DevEx / `.github`, 각 app repo owner |
| Replacement | 검증된 release commit SHA를 사용하는 thin caller |
| 확인 | 선행 표본에서 reusable ref 60개 중 53개가 `@main`이었다. P1 기반 변경은 workflow README 예시를 목표 SHA 형태로 바꾸지만 기존 release 설계 문서와 앱 caller는 P0 재검증·P2 이관 전 상태다. |
| P0 재검증 | 전체 default branch에서 `uses: seorilabs/.github/...@main` 및 다른 floating ref를 다시 검색하고 caller별 owner·market·last run을 기록 |
| 정리 후보 | SHA pinned caller로 대체된 후의 floating-ref 예시, migration shim, 중복 caller generator |
| 삭제 gate | 중앙 workflow release/SHA 고정, caller PR required checks, build-only artifact, GitHub Actions run readback, 이전 SHA rollback 절차 |

호출부 이관은 삭제 전에 완료한다. `@main` 문자열을 기계적으로 바꾸기 전에 입력·권한·secret interface가 해당 SHA와 호환되는지 검사한다.

### C-03 — `secrets: inherit`와 과도한 secret 전달

| 항목 | 내용 |
| --- | --- |
| Owner | DevEx, credential owner, 각 app repo owner |
| Replacement | reusable workflow의 named secret contract와 caller의 explicit mapping |
| 확인 | 선행 기준선의 `.github/workflows/README.md`와 기존 release 설계 문서가 `secrets: inherit`를 표준으로 제시했고 확장 caller 감사에서도 이 패턴이 다수 확인됐다. P1 기반 변경은 README 목표를 바꾸지만 reusable workflow named-secret interface와 앱 caller 이관은 P2 작업이다. |
| P0 재검증 | caller→reusable의 실제 secret 소비, org/repo/environment scope, GitHub Environment protection, 최소 permissions |
| 정리 후보 | explicit mapping 후 남은 `secrets: inherit`, 사용되지 않는 workflow secret input, 중복 org/repo 실행 복제본 |
| 삭제 gate | secret 값 없이 logical name과 consumer graph를 확정하고, 각 market의 build-only 또는 안전한 auth probe와 audit readback을 통과 |

GitHub Secret이 존재한다는 사실만으로 로컬 원본이나 소유권이 확인된 것은 아니다. 실행 복제본 삭제는 credential 원본 검증과 별도 승인이 필요하다.

### C-04 — 대체된 app-local workflow와 inline release script

| 항목 | 내용 |
| --- | --- |
| Owner | 각 app repo owner, DevEx |
| Replacement | SHA pinned org reusable workflow와 앱 고유 입력만 가진 caller |
| 확인 | 선행 12개 표본에서 표준 caller 적용은 7개 repo에 그쳤고 repo별 release 구현 차이가 있었다. |
| P0 재검증 | workflow dispatch name을 사용하는 Backoffice/Telegram/API consumer, schedule, environment, artifact path, uploader flag |
| 정리 후보 | 중앙 workflow로 대체된 inline setup/deploy step, 사용되지 않는 caller, 자동 tag 또는 push-to-main deploy 경로 |
| 삭제 gate | 동일 입력으로 build-only parity, workflow dispatch API readback, Backoffice event mapping, 이전 파일명 consumer 0건 |

artifact 생성, upload, public release를 하나로 묶은 기존 script는 먼저 build-only와 deploy 경로로 분리한다. 이 inventory 검증을 위해 production upload를 실행하지 않는다.

### C-05 — 중복 template과 SDK 복사본

| 항목 | 내용 |
| --- | --- |
| Owner | Platform SDK owner, template owner, app repo owner |
| Replacement | RN/TS exact package version 또는 Godot source/version/checksum vendor contract |
| 확인 | 선행 감사에서 repo별 공통 SDK·template·updater 방식이 일관되지 않았다. |
| P0 재검증 | import 경로, package lock, vendored file hash, updater consumer, generated file 여부, 앱 고유 patch |
| 정리 후보 | 사용되지 않는 starter template, package로 대체된 source copy, checksum 관리로 대체된 updater, dead compatibility shim |
| 삭제 gate | package/vendor parity test, 앱별 build-only artifact, 앱 고유 patch가 중앙 구현 또는 명시적 fork로 보존됨을 확인 |

Godot vendor 파일은 단순 중복으로 보지 않는다. source/version/checksum을 가진 의도적 vendor copy는 유지 대상이다.

### C-06 — agent-config 정책·reference·설치 link 중복

| 항목 | 내용 |
| --- | --- |
| Owner | Agent tooling owner, 각 skill owner |
| 정본 후보 | `~/.agent/AGENTS.md`, `~/.agent/skills/`, contract lock과 install verifier |
| 확인 | 선행 snapshot에서 `~/.agent/skills`에는 31개 `SKILL.md`와 17개 `references/` 디렉터리가 있었다. Codex와 Gemini의 symlink 설치 집합이 달랐고 `~/.agents/skills`에는 별도 skill 집합이 있었으며 `~/.agent`에는 사용자 수정 파일 4개가 있었다. 현재 release skill의 `@main`·`secrets: inherit`·GitHub macOS 지시가 새 계약과 직접 충돌한다. |
| P0 재검증 | `install.sh`, `status.sh`, `validate.sh` 결과, broken link, platform별 discover 경로, reference hash, dirty diff의 사용자 의도 |
| 정리 후보 | 중앙 org 계약을 그대로 복사한 skill reference, 중복 이름의 구형 skill, 대체된 `~/.codex/skills`/Gemini link, 설치 후 남은 compatibility path |
| 삭제 gate | 새 설치 위치와 모든 agent의 discovery 검증, contract version/hash 일치, skill routing 테스트, 사용자 dirty 변경 병합 또는 명시 보존, 사용자 승인 |

skill 자체의 작업 절차와 공식 문서 reference는 정책 중복과 다르므로 자동 삭제하지 않는다. 사용자 변경이 있는 `~/.agent`에서 `clean`, `reset`, 일괄 relink를 실행하지 않는다.

### C-07 — Backoffice legacy release 문서와 schema parser

| 항목 | 내용 |
| --- | --- |
| Owner | Backoffice owner, DevEx |
| Replacement | 기본 브랜치의 `.seorilabs/app.yaml` v1 parser와 GitHub→webhook→mirror 경로 |
| 확인 | `src/lib/seed/compute.ts`가 Play/App Store JSON, Granite config와 workflow 파일 존재 여부를 각각 읽고, `src/lib/seed/market-targets.ts`가 workflow 존재 신호로 market target을 계산한다. 관련 seed/market-target tests가 이 계약을 고정한다. |
| P0 재검증 | production이 실제 사용하는 seed/reconcile entrypoint, app별 fallback hit, configHash 의미, API/UI consumer, registry last sync/readback |
| 정리 후보 | C-01의 Backoffice release 문서, v1 manifest가 완전히 대체한 legacy config parser·regex·workflow-existence inference 및 전용 fixture/test |
| 삭제 gate | v1 parser 배포, 기존/new 결과 shadow compare, 모든 active app manifest 이관, webhook/reconcile 성공, production registry/API/UI readback, observation window |

기존 parser와 테스트는 P1에서 바로 삭제하지 않는다. shadow compare가 끝난 뒤 parser·fallback·그 fallback만 검증하던 test를 같은 cleanup PR에서 제거하고, v1 parser 회귀 test는 유지한다.

### C-08 — credential catalog entry와 외부 실행 복제본

| 항목 | 내용 |
| --- | --- |
| Owner | 해당 credential owner, Security/Platform, 사용자 |
| 정본 | `~/.config/seorilabs` catalog와 등록된 local material |
| 확인 | 선행 snapshot은 catalog 71개 entry, error 0건, warning 8건이었다. GitHub/Kubernetes Secret은 source of truth가 아니라 실행 복제본이다. |
| P0 재검증 | logical ID, `scope`, status, consumer, provider public identity, local/BeeStation backup, restore check, GitHub/Kubernetes consumer |
| 정리 후보 | provider에서 폐기된 뒤에도 남은 retired catalog entry, consumer 0건이 입증된 중복 실행 복제본, 대체 identity 전환이 끝난 compatibility credential |
| 삭제 gate | `backup-credentials.sh`, local과 BeeStation archive의 `restore-check.sh`, provider identity 확인, consumer probe, 새 identity live readback, 사용자 명시 승인 |
| 중단 조건 | catalog 누락/모호, 원본 파일 누락, fingerprint 불일치, GitHub-only Secret, backup/restore 실패, 값 노출 위험 |

warning은 삭제 목록이 아니다. 정적 키를 WIF로 대체했다는 계획만으로 기존 key를 폐기하지 않고 실제 consumer 전환과 provider readback을 먼저 입증한다.

### C-09 — SealedSecret key와 Kubernetes Secret

| 항목 | 내용 |
| --- | --- |
| Owner | Kubernetes/Platform owner, credential owner, 사용자 |
| 확인 | SealedSecret controller key는 기존 encrypted manifest를 복호화할 수 있는 외부 상태이며 일반 repo 파일과 같은 방식으로 삭제할 수 없다. |
| P0 재검증 | cluster/context/namespace, controller key fingerprint, 모든 SealedSecret manifest, 생성된 Secret consumer, 현재 rollout과 readiness |
| 정리 후보 | 새 key로 재암호화·재적용된 뒤 consumer 0건인 이전 controller key, 폐기된 workload의 실행 Secret |
| 삭제 gate | 이전 key의 암호화 백업과 임시 복원, 모든 manifest 재암호화, controller reconcile, workload restart/smoke, live Secret consumer readback, observation, 사용자 명시 승인 |
| Rollback | 이전 private key 복원 절차와 담당자가 실제로 검증돼야 함 |

새 SealedSecret이 apply됐다는 사실만으로 이전 key를 삭제하지 않는다. 모든 기존 manifest와 현재 cluster Secret의 consumer가 새 key 경로에서 복원되는지 확인해야 한다.

### C-10 — review·agent 운영 문서의 낡은 의미

| 항목 | 내용 |
| --- | --- |
| Owner | DevEx, Seori PR workflow owner |
| Replacement | machine-readable review policy와 최신 `seori-pr-workflow` 실행 계약 |
| 확인 | 선행 감사에서 Seori는 첫 번째 acceptance guide 역할이며 코드 승인자나 반복 재리뷰 gate가 아닌 것으로 확인됐다. 현재 `~/.agent/skills/seori-pr-workflow/SKILL.md`는 Copilot이 두 번 모두 미수신이어도 병합을 허용해 새 review policy의 성공 리뷰 최소 1회와 직접 충돌한다. |
| P0 재검증 | 현재 Seori workflow, check conclusion, review thread, Copilot 요청/도착 경로, ruleset required checks |
| 정리 후보 | 대체된 review prose, 잘못된 APPROVED/re-review 설명, 여러 skill에 복사된 동일 acceptance 규칙 |
| 삭제 gate | review-policy test, 실제 PR 파일럿, Seori/Copilot thread 처리와 required check readback, agent routing 검증 |

## 5. 실행 기록 형식

실제 P5 PR은 후보마다 아래 기록을 남긴다.

```yaml
cleanupId: C-00
owner: team-or-repo-owner
candidatePaths: []
canonicalReplacement: path-or-commit-sha
consumersChecked: []
liveReadback: pending
backupRestore: not-applicable
approval: pending
rollback: revert-or-restore-procedure
observationUntil: YYYY-MM-DD
status: candidate
```

허용 상태는 `candidate`, `blocked`, `approved`, `removed`, `rolled-back`이다. `removed`는 merge만으로 부여하지 않고 observation과 live readback까지 통과한 뒤 기록한다.

## 6. P5 완료 기준

- 중앙 정본과 동일한 정책 문서 복제본이 없다.
- active repo caller에 floating org workflow ref와 secret 전체 상속이 없다.
- Backoffice가 v1 manifest를 읽으며 legacy parser consumer가 0건이다.
- agent별 설치 목록과 contract hash가 verifier 결과로 일치한다.
- 모든 제거 항목에 owner, consumer, readback, 승인, rollback 기록이 있다.
- 미확인 credential 또는 SealedSecret 삭제는 0건이다.
- 제거되지 않은 후보에는 blocker, owner, 재검토 조건이 있다.
