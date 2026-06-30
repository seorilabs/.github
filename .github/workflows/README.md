# Seorilabs org 재사용 워크플로우

이 디렉터리는 org 전 repo가 공유하는 **재사용 워크플로우(`workflow_call`)** 다. 로직은 여기 한 곳에만 두고, 각 repo는 얇은 caller(`.github/workflows/*.yml`)로 호출한다. 전체 설계는 [`docs/ci-cd/org-cicd-release-system.md`](../../docs/ci-cd/org-cicd-release-system.md)(이 repo = org CI/CD single source of truth) 참조. (운영 미러: `seorilabs-backoffice/docs/ci-cd/`)

`.github` repo가 **public**이라 private repo에서도 참조 가능하다.

## 원칙

- **main 병합/PR = 정적 게이트만**(lint/typecheck/test/style + 정적 게이트). 무거운 빌드/배포 금지.
- **마켓 업로드 = 명시적 Release/Tag 기준.** merge마다 자동 태깅 금지.
- **러너**: AIT·Godot·web·lint/test → `seorilabs-rpi-arm64`(ARC). Android AAB·Play → `ubuntu-latest`. iOS·App Store → `macos-26`. public PR job은 ARC 금지.
- **아티팩트 retention = 3.**

## 워크플로우 목록

| 파일 | 용도 | 러너 |
|---|---|---|
| `rn-static-checks.yml` | RN/Node 정적 게이트(명령 주입) | ARC(또는 ubuntu) |
| `godot-checks.yml` | Godot import→compile→smoke | ARC(또는 ubuntu) |
| `godot-pages.yml` | Godot Web export + Pages 배포 | ARC(또는 ubuntu) |
| `release-tag.yml` | 명시적 SemVer 태그 생성/push | ARC |
| `rn-deploy-ait.yml` | RN .ait build + AppsInToss deploy | ARC |
| `godot-deploy-ait.yml` | Godot web→wrapper→AppsInToss deploy | ARC |
| `rn-deploy-google-play.yml` | RN 서명 AAB + Google Play 업로드 | ubuntu |
| `godot-deploy-google-play.yml` | Godot 서명 AAB + Google Play 업로드 | ubuntu |
| `rn-deploy-app-store.yml` | RN Xcode archive + App Store 업로드 | macos-26 |
| `cleanup-actions-storage.yml` | 아티팩트/캐시 정리 | ARC |

## @ref 핀 정책

- 안정화 전: `@main`.
- 안정화 후: **태그 또는 커밋 SHA로 핀**(예: `@v1` 또는 `@<sha>`)을 권장. 보안 민감 배포 워크플로우는 SHA 핀.

## secrets / variables 계약

`secrets: inherit`로 org+repo+environment 시크릿이 전달된다.

- **org secrets**(공통): `APPS_IN_TOSS_API_KEY`, `APPLE_DISTRIBUTION_CERTIFICATE_BASE64`, `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`, `APPLE_KEYCHAIN_PASSWORD`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`, `GOOGLE_PLAY_UPLOAD_KEYSTORE_BASE64`, `GOOGLE_PLAY_UPLOAD_KEYSTORE_PASSWORD`, `GOOGLE_PLAY_UPLOAD_KEY_PASSWORD`.
- **org variables**: `APPLE_TEAM_ID`, `GOOGLE_PLAY_UPLOAD_KEY_ALIAS`, `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`.
- **repo 레벨(앱 특화)**: `APPLE_PROVISIONING_PROFILE_BASE64`, `FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64`, `FIREBASE_IOS_GOOGLE_SERVICE_INFO_PLIST_BASE64`, (var) `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`.
- **GitHub Environments**: `apps-in-toss`, `google-play`, `app-store`(보호 규칙/감사).

## caller 표준 contract (repo가 제공)

- 버전 리졸버: `scripts/resolve-release-version.mjs --tag <tag> --github-output` → `version_name`, `android_version_code`, `apple_marketing_version`, `apple_build_number`, `release_name`.
- Android: `apps/mobile/android`(또는 `android`)/`gradlew :app:bundleRelease -PversionNameOverride -PversionCodeOverride`.
- Google Play 업로드: `scripts/upload-google-play-internal.py`(RN) / `tools/upload_google_play_internal.py`(Godot).
- Firebase 복원: `scripts/restore-mobile-firebase-config.mjs --android|--ios --require`.
- Godot web export: `scripts/export_godot_web.sh`.

## caller 예시

### RN 정적 게이트 (`.github/workflows/static-checks.yml`)

```yaml
name: Static Checks
on:
  pull_request: { branches: [main] }
  push: { branches: [main] }
  workflow_dispatch:
concurrency:
  group: static-checks-${{ github.ref }}
  cancel-in-progress: true
jobs:
  checks:
    uses: seorilabs/.github/.github/workflows/rn-static-checks.yml@main
    secrets: inherit
    with:
      runs_on: ${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}
      check_command: |
        pnpm lint
        pnpm typecheck
        pnpm test
```

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
jobs:
  ait:
    uses: seorilabs/.github/.github/workflows/rn-deploy-ait.yml@main
    secrets: inherit
    with:
      release_tag: ${{ inputs.release_tag }}
      memo: ${{ inputs.memo }}
```

### Deploy All 오케스트레이터 (`.github/workflows/deploy-all.yml`, repo 로컬)

```yaml
name: Deploy All
on:
  workflow_dispatch:
    inputs:
      release_tag: { type: string, required: false, default: "" }
      deploy_ait: { type: boolean, default: true }
      deploy_google_play: { type: boolean, default: true }
      deploy_app_store: { type: boolean, default: true }
permissions: { contents: read, id-token: write }
concurrency:
  group: deploy-all-${{ inputs.release_tag || github.ref }}
  cancel-in-progress: false
jobs:
  ait:
    if: ${{ inputs.deploy_ait }}
    uses: ./.github/workflows/deploy-apps-in-toss.yml
    secrets: inherit
    with: { release_tag: ${{ inputs.release_tag }} }
  google-play:
    if: ${{ inputs.deploy_google_play }}
    uses: ./.github/workflows/deploy-google-play.yml
    secrets: inherit
    with: { release_tag: ${{ inputs.release_tag }} }
  app-store:
    if: ${{ inputs.deploy_app_store }}
    uses: ./.github/workflows/deploy-app-store.yml
    secrets: inherit
    with: { release_tag: ${{ inputs.release_tag }} }
```

> Deploy All은 repo 로컬 caller들(`./.github/workflows/deploy-*.yml`)을 호출한다. 각 caller는 다시 org 재사용 워크플로우를 호출한다(2단계). 이렇게 하면 repo별 scheme/bundle 등 입력은 repo caller에 1회만 둔다.
