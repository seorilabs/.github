# Seorilabs Spec And Versioning Policy

## 목적

Agent가 여러 repo에 PR을 만들 때 스펙과 버전 판단이 흔들리지 않도록 최소 규칙을 둔다. 이 문서는 release version을 자동으로 올리기 위한 문서가 아니라, 변경이 어떤 source-of-truth와 버전 영향을 갖는지 추적하기 위한 기준이다.

## Source Types

| Source | 위치 | 관리 방식 |
| --- | --- | --- |
| Product spec | `docs/product-spec.md`, `specs/*.md` | 기능, UX, game rule, data model 변경 기준 |
| Architecture spec | `docs/architecture.md` | core/adapters boundary와 platform dependency 기준 |
| Release readiness | `docs/release-readiness.md` | QA, policy, market blocker 상태 |
| Store metadata | `play-store/`, `app-store/`, `apps-in-toss/` | market별 listing, screenshot, review notes |
| Firebase config | `firebase/` | rules, indexes, remote config, functions contract |
| Release version | GitHub `refs/tags/vX.Y.Z` | 모든 store/build version 파생, 주입, artifact readback |

## Spec Version

각 repo가 아직 명시적 spec version을 갖고 있지 않다면 PR에는 다음 중 하나를 적는다.

- 문서 경로와 commit SHA
- 문서 경로와 최종 수정일
- repo-local `spec_version` 값
- `확정 필요`

권장 표기:

```text
Spec Version: docs/product-spec.md @ <commit-sha>
Spec Version: docs/release-readiness.md updated 2026-06-17
Spec Version: 확정 필요
```

`확정 필요`는 허용하지만, spec 영향이 큰 PR은 `Needs spec`으로 분류한다.

## Version Impact

| Impact | 기준 | PR 요구사항 |
| --- | --- | --- |
| `none` | product behavior 변화 없음 | 변경 이유와 검증만 남김 |
| `patch` | bugfix, 안전한 UI/QA/policy fix | 회귀 검증 또는 smoke evidence |
| `minor` | 신규 기능, 신규 market path, user-visible behavior 추가 | product/release spec 갱신, release note 후보 |
| `major` | 저장 데이터, economy, core rule, public contract, migration 영향 | migration/rollback, human approval gate |

Agent는 `Version Impact`를 제안할 수 있다. exact source commit의 release tag 생성, 마켓 배포와 production rollout은 사람이 승인하거나 명시 티켓으로 지시해야 한다.

## Release Version

실제 release version의 유일한 정본은 exact source commit을 가리키는 GitHub stable SemVer tag `vX.Y.Z`다. 파생 규칙과 fail-closed 조건은 [`contracts/release-version-authority.yaml`](../../contracts/release-version-authority.yaml)을 따른다.

| Stack | 태그 파생값 주입 및 readback 대상 |
| --- | --- |
| React Native / Web | Gradle/Xcode artifact metadata, app config |
| Godot | `export_presets.cfg`, AAB manifest, Xcode archive |
| AppsInToss | `granite.config.ts`, `.ait` artifact digest와 배포 memo |
| Firebase Functions | 배포 대상 source SHA와 release binding |

`package.json`, Gradle, Xcode, Godot, Granite와 마켓 config의 version 값은 정본이 아니다. Agent는 이 로컬 값을 release version 결정에 사용하거나 독립적으로 bump하지 않는다. 승인된 release 작업은 선택된 exact source commit에 tag를 만들고, 중앙 workflow가 tag 파생값을 주입한 뒤 artifact에서 다시 읽어 검증한다.

## Required PR Fields

모든 agent PR은 다음을 적는다.

```text
Source of truth:
Spec Version:
Version Impact:
Migration needed:
```

값을 알 수 없으면 비워두지 말고 `확정 필요` 또는 `Not applicable`로 적는다.

## Intake Rules

- spec path가 없으면 `Needs spec`
- version impact가 없으면 `Needs spec`
- migration 영향이 있는데 rollback이 없으면 `Needs spec`
- release 영향이 있는데 release approval이 없으면 `Blocked by approval`
- 검증 증거가 없으면 `Needs tests`

## Changelog And Release Notes

`minor` 또는 `major` PR은 release note 후보를 남긴다. 실제 GitHub Release 또는 store release note 작성은 release task에서 확정한다.

권장 형식:

```text
Release note candidate:
- 사용자가 볼 수 있는 변화:
- 운영자가 알아야 할 변화:
- migration/rollback:
```

## Remote Config

Remote Config, feature flag, monetization flag 변경은 product behavior에 영향을 줄 수 있다.

- template 변경만 있으면 `patch` 또는 `minor`를 검토한다.
- production value 변경은 release/ops ticket과 approval 상태를 확인한다.
- repo template과 실제 console 값이 어긋나면 source-of-truth를 먼저 명시한다.
