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

`@seorilabs/repo-contract/fleet-migration`은 P7 legacy 운영 JSON, `secrets: inherit`, floating 중앙 workflow ref를 서명된 전체 GitHub App pagination inventory와 exact commit/tree/BLOB readback에 묶어 분류합니다. source repository와 P5 classification revision으로 확정한 PRODUCT_APP subject를 분리하되, cross-repo는 `PLATFORM_REGISTRY_APP`과 ACTIVE App/PlatformFleetBinding revision·digest readback이 모두 일치할 때만 허용합니다. fork, 중복 registry-to-app mapping, 모호한 subject는 fail-closed합니다. ACTIVE config/signed snapshot/replacement에 묶인 build-only, 검증 시각 기준 authoritative parity head/total/TTL, replacement가 정한 CredentialBinding provider/capability/environment/public identity/policy revision과 scope/generation, consumer 0/parser disabled/dispatch readback, exact-tree Git restore가 모두 일치해야 합니다. 최초 38/73/108/87 수치는 `BOOTSTRAP`에만 쓰며 후속 `WAVE`는 `--prior-inventory`의 신뢰 digest를 잇고 cleanup count를 단조 감소시킵니다. 각 WAVE inventory는 BOOTSTRAP부터 직전 WAVE까지의 서명된 compact checkpoint와 누적 `chainDigest`를 포함합니다. WAVE chain head는 별도 state authority가 durable CAS로 exact current generation/head에서 candidate inventory ID/digest/signedAt으로 확보한 단일 reservation이어야 합니다. loader는 signed artifact만 믿지 않고 주입된 `trustedStateAuthorityReadback`에서 현재 reservation 전체를 다시 읽어 대조하므로, state가 진행된 뒤의 old head와 동일 parent sibling은 binding을 얻지 못합니다. 이 adapter가 없으면 standalone CLI도 `FLEET_MIGRATION_STATE_AUTHORITY_READBACK_REQUIRED`로 fail-closed합니다. inventory signer와 chain-head authority의 key ID와 SPKI는 WAVE 검증 시 합쳐진 inventory trust set에서도 다시 분리합니다. 출력은 항상 `PLAN_ONLY`·stdout 전용이며 repository write, PR 생성, 파일 삭제·rewrite API를 제공하지 않습니다. CLI의 모든 outcome 의미 검증에는 `--inventory`, `--trusted-key-id`, `--trusted-public-key`가 필요하고 wave에는 `--prior-inventory`, `--chain-head`, `--trusted-chain-head-key-id`, `--trusted-chain-head-public-key`와 trusted live readback adapter도 필요합니다. `validateFleetMigrationPlanStructure`는 구조만 확인하며 권위 검증이 아닙니다. 실제 collector, durable CAS state authority, attestation issuer, executor는 이 패키지 범위 밖이고 private key 입력은 거부합니다. 이 패키지는 외부 CAS를 구현했다고 주장하지 않으며 executor는 mutation 직전에 같은 reservation을 CAS로 소비하고 exact head를 다시 읽어야 합니다. `planDigest`는 권한이 아닙니다.

`@seorilabs/repo-contract/workflow-bundle-v5`는 앱 소스가 아닌 Backoffice의 서명된
resolved binding을 받아 `staticBinding`과 target별 `buildBindings`를 분리합니다.
현재 v5 승격 범위는 static 네 profile뿐이며 `buildProfiles`는 빈 목록입니다. JS와 Godot v3
static caller는 source/config를 파일에 고정하지 않는 무입력 caller입니다. 실행 시 GitHub OIDC로 exact event
SHA의 Backoffice manifest를 다시 읽습니다. push와 workflow_dispatch는 exact main SHA에
결합합니다. PR query는 merge SHA를 application source로, base SHA를 signed config binding
source로 분리하고, Backoffice가 open PR의 base/head repository·ref·base SHA·merge SHA를 trusted
GitHub App readback으로 exact 검증해야만 manifest를 반환합니다. 불일치는 fail-closed합니다.
PAUSED는 runtime static SHADOW,
DEPRECATED는 no-caller입니다. Capacitor, Granite AIT, AIT web과 Xcode Cloud build 정의는
cold-cache·격리 후보 검증만 수행하며, 별도로 검토된 signed build OIDC 계약이 생기기 전에는
caller/runtime 생성기가 `BUILD_RUNTIME_BINDING_UNAVAILABLE`로 app checkout 전에 멈춥니다.
Godot v3는 `job.workflow_ref`의 exact 경로와 `godot`/`packageManager: null` 조합을 함께
검증하며 앱 코드 job과 provenance job을 분리합니다. 기존 Godot v2와 WorkflowBundle v4.1은
변경하지 않습니다.

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
