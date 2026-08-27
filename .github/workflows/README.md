# Seorilabs org 재사용 워크플로우

이 디렉터리는 org 전 repo가 공유하는 **재사용 워크플로우(`workflow_call`)** 다. 로직은 여기 한 곳에만 두고, 각 repo는 얇은 caller(`.github/workflows/*.yml`)로 호출한다.

신규 caller의 규범 정본은 [`contracts/release-policy.yaml`](../../contracts/release-policy.yaml)이며 테스트·리뷰 계약은 각각 [`contracts/test-policy.yaml`](../../contracts/test-policy.yaml), [`contracts/review-policy.yaml`](../../contracts/review-policy.yaml)을 따른다. 기존 [`org-cicd-release-system.md`](../../docs/ci-cd/org-cicd-release-system.md)는 현행 워크플로우를 이관하기 위한 legacy 참고 문서다.

`.github` repo가 **public**이라 private repo에서도 참조 가능하다.

## 원칙

- **main 병합/PR = 정적 게이트만**(lint/typecheck/test/style + 정적 게이트). 무거운 빌드/배포 금지.
- **마켓 업로드 = 명시적 Release/Tag 기준.** merge마다 자동 태깅 금지.
- **러너**: AIT·Godot·web·lint/test → `seorilabs-rpi-arm64`(ARC). Android AAB·Play → x64 Linux. Apple archive·App Store 업로드 → Xcode Cloud. public PR job은 ARC 금지.
- **호출 계약**: reusable workflow는 검증된 full commit SHA로 고정하고, secret은 `workflow_call.secrets`에 선언한 이름만 명시적으로 전달한다.
- **아티팩트 retention = 3.**
- **private GitHub Packages 소비**: caller는 `permissions.packages: read`만 선언한다. v2
  재사용 워크플로우가 고정 registry와 scope를 설정하고 install child process에만
  `github.token`을 제공한다.

## 워크플로우 목록

| 파일 | 용도 | 러너 |
|---|---|---|
| `rn-static-checks-v2.yml` | Fleet RN 고정 품질 게이트와 provenance | private ARC, public ubuntu |
| `godot-checks-v2.yml` | Fleet Godot 고정 품질·import 게이트와 provenance | private ARC, public ubuntu |
| `workflow-bundle-candidate.yml` | 불변 WorkflowBundle candidate 생성·검증 | private ARC, public ubuntu |
| `rn-static-checks.yml` | RN/Node 정적 게이트(명령 주입) | ARC(또는 ubuntu) |
| `rn-build-ait.yml` | RN `.ait` 후보 산출물 빌드(배포 없음) | ARC 또는 x64 Linux |
| `rn-build-android.yml` | RN signed AAB 후보 산출물 빌드(배포 없음) | ubuntu |
| `godot-checks.yml` | Godot import→compile→smoke | ARC(또는 ubuntu) |
| `godot-pages.yml` | Godot Web export + Pages 배포 | ARC(또는 ubuntu) |
| `release-tag.yml` | 명시적 SemVer 태그 생성/push | ARC |
| `rn-deploy-ait.yml` | RN .ait build + AppsInToss deploy | ARC |
| `godot-deploy-ait.yml` | Godot web→wrapper→AppsInToss deploy | ARC |
| `rn-deploy-google-play.yml` | RN 서명 AAB + Google Play 업로드 | ubuntu |
| `godot-deploy-google-play.yml` | Godot 서명 AAB + Google Play 업로드 | ubuntu |
| `rn-deploy-app-store.yml` | RN GitHub-hosted App Store 경로 — legacy migration 대상 | macos-26 |
| `godot-deploy-app-store.yml` | Godot GitHub-hosted App Store 경로 — legacy migration 대상 | macos-26 |
| `cleanup-actions-storage.yml` | 아티팩트/캐시 정리 | ARC |

## @ref 핀 정책

- 신규·이관 caller는 검증된 **40자리 full commit SHA**로 고정한다.
- `@main`, branch, mutable major tag는 신규 caller에서 사용하지 않는다.
- 중앙 workflow 변경은 새 SHA의 계약·정적 검증과 선언 마켓별 build-only canary 후 앱별 PR로 올린다. 이전 SHA는 rollback 근거로 남긴다.

신규 Fleet caller는 trusted approval key와 registry readback을 가진 GitHub App reconciler가
[`repo-contract`](../../packages/repo-contract/) library generator로만 만든다.
v2 workflow는 caller가 runner, install 명령, check 명령을 넘길 수 없고 public repository를
ARC에서 중앙 차단한다. 기존 명령 주입형 workflow는 consumer shadow parity가 끝날 때까지만
유지하며 신규 caller에서 사용하지 않는다.

GitHub Jobs API의 물리 check 이름은 reusable workflow 특성상 `<caller job> / <called job>`이다.
따라서 Fleet ruleset이 요구할 final evidence check는 `Org Contract / Org Contract`이며,
`Fleet Quality` 실패·취소도 이 final job이 fail-closed로 반영한다. 단독 `Org Contract`는
workflow/caller의 표시 이름일 뿐 required status check 이름으로 사용하지 않는다.

## secrets / variables 계약

`secrets: inherit`는 신규·이관 caller에서 금지한다. 재사용 워크플로우는 필요한 이름을 `on.workflow_call.secrets`에 선언하고 caller는 같은 이름을 하나씩 매핑한다. 아래 목록은 현재 이관할 logical name inventory이며 값의 정본은 저장소가 아니다.

- **org secrets**(공통): `APPS_IN_TOSS_API_KEY`, `APPLE_DISTRIBUTION_CERTIFICATE_BASE64`, `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`, `APPLE_KEYCHAIN_PASSWORD`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`, `GOOGLE_PLAY_UPLOAD_KEYSTORE_BASE64`, `GOOGLE_PLAY_UPLOAD_KEYSTORE_PASSWORD`, `GOOGLE_PLAY_UPLOAD_KEY_PASSWORD`.
- **org variables**: `APPLE_TEAM_ID`, `GOOGLE_PLAY_UPLOAD_KEY_ALIAS`, `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`.
- **repo 레벨(앱 특화)**: `APPLE_PROVISIONING_PROFILE_BASE64`, `FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64`, `FIREBASE_IOS_GOOGLE_SERVICE_INFO_PLIST_BASE64`, (var) `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`.
- **GitHub Environments**: `apps-in-toss`, `google-play`, `app-store`(보호 규칙/감사).

Apple signing과 App Store Connect 인증은 Xcode Cloud 환경에서 관리한다. 아래 GitHub App Store secret과 workflow는 소비자를 확인한 뒤 Xcode Cloud로 옮길 legacy 대상이며 신규 앱의 표준이 아니다.

## caller 표준 contract (repo가 제공)

- 버전 리졸버: `scripts/resolve-release-version.mjs --tag <tag> --github-output` → `version_name`, `android_version_code`, `apple_marketing_version`, `apple_build_number`, `release_name`.
- Android: `apps/mobile/android`(또는 `android`)/`gradlew :app:bundleRelease -PversionNameOverride -PversionCodeOverride`.
- Google Play 업로드: `scripts/upload-google-play-internal.py`(RN) / `tools/upload_google_play_internal.py`(Godot).
- Godot Android에서 import 전 공개 runtime config 복원이나 최종 AAB 정책 검사가 필요하면 각각 `prepare_project_script`, `post_export_validation_script`를 넘긴다. 후자에는 `AAB_PATH`, `ANDROID_VERSION_NAME`, `ANDROID_VERSION_CODE`가 전달된다.
- Firebase 복원: `scripts/restore-mobile-firebase-config.mjs --android|--ios --require`.
- Godot web export: `scripts/export_godot_web.sh`.
- Legacy GitHub App Store 경로의 Godot iOS: `scripts/ensure_godot.sh --with-export-templates`, `scripts/export_godot_ios.sh`(→ `<ios_output>.xcodeproj`). 이 입력 계약은 Xcode Cloud 이관 전 기존 consumer 확인에만 사용한다.

## caller 예시

배포 예시는 named secret 계약 이관 후의 목표 형태다. 중앙 deploy workflow가 해당
`workflow_call.secrets`를 선언한 검증 SHA가 나오기 전에는 앱 caller에 적용하지 않는다.

### RN AIT 후보 빌드 (`.github/workflows/build-ait.yml`)

```yaml
name: Build Mini-app Candidate
on:
  workflow_dispatch:
    inputs:
      release_tag: { type: string, required: false, default: "" }
jobs:
  build:
    uses: seorilabs/.github/.github/workflows/rn-build-ait.yml@<full-commit-sha>
    with:
      release_tag: ${{ inputs.release_tag }}
```

이 경로는 `.ait` artifact만 만들며 AppsInToss API를 호출하지 않는다. 실제 업로드는
아래 `rn-deploy-ait.yml` caller와 deployment 승인을 별도로 사용한다.

Android 후보 빌드도 `rn-build-android.yml`을 사용한다. 이 경로는 서명 AAB artifact만
생성하고 `google-play` environment, WIF, Google Play API를 사용하지 않는다. Gradle
의존성은 GitHub Actions cache로 재사용하며, caller는 `react_native_architectures`로
release AAB에 컴파일할 ABI를 명시할 수 있다. 입력을 비우면 프로젝트 기본값을 유지한다.

### RN 정적 게이트 (`.github/workflows/org-contract.yml`)

```yaml
name: Org Contract
on:
  pull_request:
  push: { branches: [main] }
  workflow_dispatch:
permissions:
  contents: read
  packages: read
concurrency:
  group: org-contract-${{ github.repository_id }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  org-contract:
    name: Org Contract
    uses: seorilabs/.github/.github/workflows/rn-static-checks-v2.yml@<full-commit-sha>
    with:
      package_manager: pnpm
      working_directory: .
```

이 파일은 사람이 복사하지 않고 GitHub App reconciler가 검증된 APPROVED bundle에서
생성한다. stack 후보가 둘 이상이거나 exact `refs/heads/main` observation이 없으면 생성하지
않고 `needs_input`으로 멈춘다.

### RN AIT 배포 (`.github/workflows/deploy-apps-in-toss.yml`)

```yaml
name: Deploy AppsInToss
on:
  workflow_dispatch:
    inputs:
      release_tag: { type: string, required: false, default: "" }
      memo: { type: string, required: false, default: "" }
  workflow_call:
    inputs:
      release_tag: { type: string, required: false, default: "" }
      memo: { type: string, required: false, default: "" }
    secrets:
      APPS_IN_TOSS_API_KEY: { required: true }
jobs:
  ait:
    uses: seorilabs/.github/.github/workflows/rn-deploy-ait.yml@<full-commit-sha>
    secrets:
      APPS_IN_TOSS_API_KEY: ${{ secrets.APPS_IN_TOSS_API_KEY }}
    with:
      release_tag: ${{ inputs.release_tag }}
      memo: ${{ inputs.memo }}
```

### GitHub 마켓 오케스트레이터 (`.github/workflows/deploy-all.yml`, repo 로컬)

```yaml
name: Deploy All
on:
  workflow_dispatch:
    inputs:
      release_tag: { type: string, required: false, default: "" }
      deploy_ait: { type: boolean, default: true }
      deploy_google_play: { type: boolean, default: true }
permissions: { contents: read, id-token: write }
concurrency:
  group: deploy-all-${{ inputs.release_tag || github.ref }}
  cancel-in-progress: false
jobs:
  ait:
    if: ${{ inputs.deploy_ait }}
    uses: ./.github/workflows/deploy-apps-in-toss.yml
    secrets:
      APPS_IN_TOSS_API_KEY: ${{ secrets.APPS_IN_TOSS_API_KEY }}
    with: { release_tag: ${{ inputs.release_tag }} }
  google-play:
    if: ${{ inputs.deploy_google_play }}
    uses: ./.github/workflows/deploy-google-play.yml
    secrets:
      FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64: ${{ secrets.FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64 }}
      GOOGLE_PLAY_UPLOAD_KEYSTORE_BASE64: ${{ secrets.GOOGLE_PLAY_UPLOAD_KEYSTORE_BASE64 }}
      GOOGLE_PLAY_UPLOAD_KEYSTORE_PASSWORD: ${{ secrets.GOOGLE_PLAY_UPLOAD_KEYSTORE_PASSWORD }}
      GOOGLE_PLAY_UPLOAD_KEY_PASSWORD: ${{ secrets.GOOGLE_PLAY_UPLOAD_KEY_PASSWORD }}
    with: { release_tag: ${{ inputs.release_tag }} }
```

> 이 예시는 GitHub에서 실행하는 AIT·Google Play 경로만 묶는다. Apple archive와 App Store 업로드는 Xcode Cloud에서 별도 gate로 실행한다. repo 로컬 caller도 각 `workflow_call.secrets` 이름을 선언하고 중앙 workflow에 다시 명시적으로 매핑해야 한다.
