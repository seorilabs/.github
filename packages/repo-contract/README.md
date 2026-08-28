# @seorilabs/repo-contract

Seorilabs 앱 저장소의 선언과 필수 파일을 조직 계약으로 검증하는 Node.js 24 CLI입니다. 배포 패키지에는 검증에 사용한 `contracts/`와 `profiles/` 스냅샷이 함께 포함됩니다.

```bash
repo-contract [저장소 경로]
```

저장소 경로를 생략하면 현재 디렉터리를 검사합니다. 기본 manifest는 `<저장소>/.seorilabs/app.yaml`입니다.

- 종료 코드 `0`: 모든 계약 통과
- 종료 코드 `1`: 문서 파싱, 스키마, 의미 또는 필수 파일 계약 실패
- 종료 코드 `2`: 잘못된 CLI 사용법

진단은 문서명, JSON path, 고정 오류 코드만 표시하며 자격증명 값을 출력하지 않습니다.

`@seorilabs/repo-contract/bootstrap`은 GitHub App의 repository·기본 브랜치 push webhook을 검증하고 zero-touch 등록 계획을 만듭니다. webhook secret은 재사용하는 Backoffice App 전용 `shared/github/backoffice-app-webhook` logical ID를 통해 trusted loader에만 요청하며 반환값에는 포함하지 않습니다. 생성 계획은 `contracts/fleet-bootstrap-plan.schema.json`을 따르고 durable delivery 저장이 성공한 뒤에만 완료됩니다.

`@seorilabs/repo-contract/trusted-executor`는 durable queue에서 exact plan digest가 `EXECUTABLE`임을 다시 읽은 뒤 GitHub App token을 operation별 repository와 최소 permission으로 한정합니다. custom property, Environment, caller PR, 조직 secret visibility를 실행하고 exact identity/state readback 뒤 secret-free receipt를 저장합니다. Android callee가 요구하는 공개 WIF provider와 Cloud Build submitter/executor identity는 중앙 catalog와 exact match하는 `internal` Environment variables로 WIF binding과 함께 reconcile합니다. WIF는 shared provider와 repo·중앙 workflow·environment를 묶은 compound principal을 사용하는 별도 GCP adapter가 담당합니다. Enterprise는 조직 ruleset, Team은 repo별 branch protection을 사용하며 SHADOW는 read-only, ACTIVE는 별도 승인 뒤 단조 강화만 허용합니다.

조직 secret selected-repository 목록, custom property map, shared WIF etag처럼 다른 repo의 additive 작업으로 변하는 provider superset은 stable satisfaction witness와 현재 `readbackDigest`로 분리합니다. target binding이 유지되면 완료 작업을 mutation 없이 replay하고, target 자체가 사라지면 실패합니다.

`@seorilabs/repo-contract/trusted-candidate-canary`는 CANDIDATE bundle을 Happy Farm과 Lizard Tycoon 두 고정 repo에만 적용하는 전용 경계입니다. 중앙 source/integrity와 Backoffice exact-source manifest를 다시 읽고, exact candidate `job_workflow_ref`에 묶인 `CANDIDATE_WIF_PREBIND` 5분·1회 승인을 CAS로 소비한 뒤 shared WIF binding을 read-before/apply-CAS/read-after 합니다. 그 후에만 static 및 Android build-only caller 두 개를 idempotent PR로 생성합니다. 일반 fleet generator는 계속 APPROVED bundle만 받습니다.

`@seorilabs/repo-contract/trusted-publisher`는 WorkflowBundle signer와 registry publish/readback을 GitHub executor에서 분리합니다. worker는 `shared/workflow-bundle/approval-signing` logical ID만 알고 private key를 받지 않습니다.

`@seorilabs/repo-contract/fleet`의 WorkflowBundle v4 API는 static caller 외에 다음 shadow
계약을 제공합니다.

- `generateAndroidBuildCaller` / `validateAndroidBuildCaller`: full SHA reusable workflow,
  최소 권한, Backoffice-bound source SHA concurrency, zero-secret Android build-only caller.
  callee는 managed caller의 main ref를 Google WIF 전에 다시 검증
- `generateXcodeCloudRunContract` / `validateXcodeCloudRunContract`: GitHub macOS 없이
  trusted ExternalBinding readback의 App Store Connect `ciBuildRuns.create` 대상을 호출하는
  exact-source Xcode Cloud envelope와 deep-frozen validated snapshot
- `evaluateLegacyWorkflow`: `@main`, `secrets: inherit`, 임의 runner와 GitHub-hosted
  Android/macOS 이탈을 차단하지 않고 `SHADOW/EVALUATE` observation으로 분류
- `evaluatePlatformReleaseGate`: static은 shadow, release는 signed fleet-approved manifest와
  Backoffice observation receipt가 없으면 fail-closed
- `consumePlatformReleaseGateBinding`: release 직전 5분 TTL과 exact identity를 다시 확인하고
  trusted Backoffice adapter의 receipt ID/generation durable CAS로 opaque gate binding을 한 번만 소비

이 API는 APPROVED bundle registry와 Backoffice resolved manifest readback 없이는 caller를
생성하지 않는다. 현재 v4 rollout은 shadow이며 기존 consumer를 자동 수정하지 않는다.

React Native monorepo는 `sdk.consumers`에 실제 SDK를 import하는 각 `package.json`과 대응하는 pnpm lockfile importer를 선언합니다. 검증기는 모든 consumer의 정확한 package 버전과 lockfile resolution, GitHub Packages tarball, SHA-512 integrity를 확인합니다.

Godot `SOURCE`는 `VERSION`과 같은 tag의 `seorilabs/platform` GitHub release URL이어야 합니다. `CHECKSUM`은 `profiles/godot.yaml`의 `vendored-tree-v1` 규칙으로 계산합니다. SDK 루트의 `CHECKSUM`만 제외하고 `SOURCE`, `VERSION`, 일반 파일의 상대 경로와 내용을 순서대로 해시하며 symlink는 허용하지 않습니다.
