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

`@seorilabs/repo-contract/bootstrap`은 GitHub App의 repository·기본 브랜치 push webhook을 검증하고 zero-touch 등록 계획을 만듭니다. webhook secret은 `shared/github/fleet-app-webhook` logical ID를 통해 trusted loader에만 요청하며 반환값에는 포함하지 않습니다. 생성 계획은 `contracts/fleet-bootstrap-plan.schema.json`을 따르고 durable delivery 저장이 성공한 뒤에만 완료됩니다. 실제 GitHub·Backoffice 변경은 idempotency key를 검증하는 별도 trusted executor의 책임입니다.

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
