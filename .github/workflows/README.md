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
  Docker 자동 build record도 `DOCKER_BUILD_RECORD_RETENTION_DAYS: "3"`을 명시한다.
  미지정 또는 `0`은 저장소·조직 기본 보존 기간을 사용하므로 허용하지 않는다.
- **private GitHub Packages 소비**: caller는 `permissions.packages: read`만 선언한다. v2
  재사용 워크플로우가 고정 registry와 scope를 설정하고 install child process에만
  `github.token`을 제공한다.

## 워크플로우 목록

| 파일 | 용도 | 러너 |
|---|---|---|
| `rn-static-checks-v2.yml` | Fleet RN 고정 품질 게이트와 provenance | private ARC, public ubuntu |
| `godot-checks-v2.yml` | Fleet Godot 고정 품질·import 게이트와 provenance | private ARC, public ubuntu |
| `godot-checks-v3.yml` | v5 OIDC runtime binding에 결합된 Godot import·진단 게이트와 target evidence | private ARC, public ubuntu |
| `workflow-bundle-candidate.yml` | 불변 WorkflowBundle candidate 생성·검증 | private ARC, public ubuntu |
| `workflow-bundle-v5-candidate.yml` | v5 split binding 계약과 Saju/Trait/Godot fixture candidate 생성·검증 | private ARC, public ubuntu |
| `js-static-checks-v1.yml` | OIDC runtime manifest에 결합된 RN·Capacitor·AIT web canonical static gate와 target evidence | private ARC, public ubuntu |
| `ait-build-only-v1.yml` | exact peeled stable tag에서 AIT 1개와 checksum provenance 생성, 업로드 없음 | private ARC, public stable-tag ubuntu |
| `ait-upload-v1.yml` | 공용 key 비노출 broker adapter가 준비될 때까지 `RUNTIME_NOT_OPERATIONAL` | public ubuntu, PR 비실행 |
| `capacitor-build-android-cloud-v1.yml` | Capacitor exact source를 x64 Cloud Build에서 build-only AAB로 생성 | private ARC submit + x64 Cloud Build |
| `rn-build-android-cloud-v1.yml` | RN exact source를 Cloud Build에 제출하고 build-only AAB 회수 | private ARC submit + x64 Cloud Build |
| `godot-build-android-cloud-v1.yml` | Godot exact source를 Cloud Build에 제출하고 build-only AAB 회수 | private ARC submit + x64 Cloud Build |
| `rn-static-checks.yml` | RN/Node 정적 게이트(명령 주입) | ARC(또는 ubuntu) |
| `rn-build-ait.yml` | RN `.ait` 후보 산출물 빌드(배포 없음) | ARC 또는 x64 Linux |
| `rn-build-android.yml` | RN signed AAB 후보 산출물 빌드(배포 없음) | ubuntu |
| `godot-checks.yml` | Godot import→compile→smoke | ARC(또는 ubuntu) |
| `godot-pages.yml` | Godot Web export + Pages 배포 | ARC(또는 ubuntu) |
| `release-tag.yml` | 지정 commit에 명시적 SemVer 태그 생성/push(마커 커밋·브랜치 push 없음) | ARC |
| `rn-deploy-ait.yml` | RN .ait build + AppsInToss deploy | ARC |
| `godot-deploy-ait.yml` | Godot web→wrapper→AppsInToss deploy | ARC |
| `rn-deploy-google-play.yml` | RN 서명 AAB + Google Play 업로드 | private `seorilabs-x64-android`, public `ubuntu-latest` |
| `godot-deploy-google-play.yml` | Godot 서명 AAB + Google Play 업로드 | `seorilabs-x64-android` |
| `rn-deploy-app-store.yml` | RN GitHub-hosted App Store 경로 — legacy migration 대상 | macos-26 |
| `godot-deploy-app-store.yml` | Godot GitHub-hosted App Store 경로 — legacy migration 대상 | macos-26 |
| `cleanup-actions-storage.yml` | 아티팩트/캐시 정리 | ARC |
| `jansoree-review-v1.yml` | PR diff를 MiniMax 브레인 Claude Code로 리뷰하고 jansoree 앱 명의로 코멘트 게시(파일럿, review-policy 계약 미전환) | private ARC, public ubuntu |

## @ref 핀 정책

- 신규·이관 caller는 검증된 **40자리 full commit SHA**로 고정한다.
- `@main`, branch, mutable major tag는 신규 caller에서 사용하지 않는다.
- 중앙 workflow 변경은 새 SHA의 계약·정적 검증과 선언 마켓별 build-only canary 후 앱별 PR로 올린다. 이전 SHA는 rollback 근거로 남긴다.

신규 Fleet caller는 trusted approval signer와 registry readback을 가진 GitHub App reconciler가
[`repo-contract`](../../packages/repo-contract/) library generator로만 만든다.
JS와 Godot v3 static caller는 source/config snapshot을 포함하지 않는다. `github.workflow_ref`로 caller를,
`job.workflow_ref`·`job.workflow_sha`로 called reusable workflow를 구분하고, push·dispatch는
event SHA에 결합한다. PR query는 merge SHA와 base SHA를 분리하고 Backoffice가 open PR의
base/head repository·ref·base SHA·merge SHA를 trusted GitHub App readback으로 exact 검증한다.
불일치와 stale readback은 OIDC-only job에서 fail-closed한다.
따라서 caller 설치 커밋이나 다음 main 커밋이 embedded SHA를 stale하게 만들지 않는다.
called workflow 경로는 JS profile과 npm/pnpm 또는 Godot profile과 null package manager 조합에
exact하게 묶는다. 기존 Godot v2와 WorkflowBundle v4.1은 변경하지 않는다. AIT build profile은
public stable tag와 peeled commit을 exact match하는 GitHub-hosted build-only 경로를 포함하지만
promotion scope와 public Backoffice runtime readback이 준비되기 전에는 caller를 만들지 않는다.
AIT upload는 같은 parent run의 `ait-build` 성공, checksum provenance, `apps-in-toss` Environment
bootstrap·approval, broker 내부 SHA-pinned trusted adapter가 모두 필요하다. 현재 adapter가 없어
`ait-upload-v1.yml`은 secret을 받지 않고 `RUNTIME_NOT_OPERATIONAL`로 fail-closed한다.
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

WorkflowBundle v4 Android build-only 경로는 GitHub secret을 받지 않는다. `internal`
Environment에서 공개 identity인 `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`,
`SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT`,
`SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT` 변수만 읽고 WIF로 `seorilabs-ci`에 제출한다.
중앙 zero-touch reconciler는 세 변수를 trusted public catalog와 exact match한 뒤 WIF binding과
같은 logical credential revision으로 먼저 설정하고 provider readback까지 완료한다.
Cloud Build 실행 SA의 Secret Manager 단위 IAM은 별도 credential binding이 관리하며 Play
publisher 권한을 가져서는 안 된다. GitHub OIDC 조건은 숫자 repository ID와 중앙
`job_workflow_ref`의 full SHA를 pilot별 쌍으로 제한해 교차 조합을 거부한다.

## caller 표준 contract (repo가 제공)

- 버전 리졸버는 caller가 제공하지 않는다. 재사용 워크플로우가 called-workflow exact SHA로
  `seorilabs/.github`를 받아 `scripts/release/resolve-release-version.mjs`를 실행하고,
  릴리즈 태그에서 `version_name`, `android_version_code`, `apple_marketing_version`,
  `apple_build_number`, `release_name`을 파생한다. 저장소 로컬
  `scripts/resolve-release-version.mjs`와 caller `version_name`/`version_code`/`version_script`
  입력은 제거됐다. 계약은 [`contracts/release-version-authority.yaml`](../../contracts/release-version-authority.yaml).
- Android: `apps/mobile/android`(또는 `android`)/`gradlew :app:bundleRelease -PversionNameOverride -PversionCodeOverride`.
- Google Play 업로드: exact central SHA의 `scripts/release/upload-google-play-aab.py`.
  두 도구 모두 `--aab-path`로 받은 **검증된 파일 하나만** 업로드한다. 스스로 AAB를 탐색하지 않는다.
  워크플로우는 업로드 직전에 그 경로의 sha256을 다시 계산해 대조하고(post-export/readiness 이후),
  검증된 파일이 있는 디렉터리에 `.aab`가 하나뿐인지 확인한다. 도구는 `SEORI_EXPECTED_AAB_SHA256`과
  `SEORI_EXPECTED_ANDROID_VERSION_CODE`를 필수로 요구하고, AAB manifest package가 Backoffice
  BuildTarget package와 다르면 provider 호출 전에 차단한다.
- 트랙 승격: `promote-google-play.yml`은 태그에서 파생한 versionCode를 `--promote-version-code`로
  넘긴다. 트랙의 "최신 build"를 승격하지 않는다.
- AppsInToss 배포: 저장소 `deploy` 스크립트는 워크플로우가 준 `--memo`와 `--location`을 **그대로**
  전달한다. memo에는 태그 파생값과 artifact sha256이 들어 있어 다시 만들거나 자르면 대조가 깨지고,
  `--location`은 검증된 exact absolute 경로다.
- 러너: `release-tag.yml`은 `seorilabs-rpi-arm64`, Godot Play와 private RN Play은
  `seorilabs-x64-android`로 중앙에서 고정한다. public RN repo는 `ubuntu-latest`로만
  라우팅해 private ARC를 노출하지 않는다. caller가 러너를 선택하는 `runs_on` 입력은 없다.
- Godot export preset: 버전 주입 대상과 `godot --export-release` 대상이 같은 preset이어야 한다.
  Google Play는 `android_export_preset`(기본 `Android`), App Store는 `ios_export_preset`으로 명시한다.
- Godot Android에서 import 전 공개 runtime config 복원이나 최종 AAB 정책 검사가 필요하면 각각 `prepare_project_script`, `post_export_validation_script`를 넘긴다. 후자에는 `AAB_PATH`, `ANDROID_VERSION_NAME`, `ANDROID_VERSION_CODE`가 전달된다.
- 결제 plugin·동적 Gradle preset처럼 중앙 direct export로 표현할 수 없는 Godot repo는 `build_script`를 넘긴다. 중앙이 태그 파생 `SEORI_RELEASE_*`와 exact `SEORI_ANDROID_AAB_OUTPUT`만 child process에 주입하고, upload와 provider API는 계속 중앙 workflow만 소유한다.
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

이 파일은 사람이 복사하지 않고 GitHub App trusted executor가 검증된 APPROVED bundle에서
생성한다. stack 후보가 둘 이상이거나 exact `refs/heads/main` observation이 없으면 생성하지
않고 `needs_input`으로 멈춘다.

### Android build-only shadow caller

`generateAndroidBuildCaller`가 APPROVED bundle과 Backoffice resolved manifest에서만 만든다.
caller는 사용자 SHA 입력 없이 resolved manifest의 exact source SHA, 최소
권한, source SHA별 concurrency, full workflow SHA만 가진다. RN은 private Platform SDK를
받아야 하므로 `contents: read`·`id-token: write`·`packages: read`, Godot은
`contents: read`·`id-token: write`만 사용한다.
`secrets`, `runs-on`, `steps`, 임의 command 입력은 허용하지 않는다. 중앙 reusable workflow는
private repo에서만 digest-bound ARC image를 사용하고, Google WIF 전에 managed caller가
`.github/workflows/android-build-only.yml@refs/heads/main`인지 확인한 뒤 exact source
checkout과 tracked-secret scan 뒤 x64 Cloud Build로 제출한다. Cloud Build config는 digest로
고정한 builder, exact gcloud와 `scripts/build-android.sh`만 실행하며 AAB를 회수할 뿐 마켓
API를 호출하지 않는다. RN private SDK는 RPI에서 일회성 `github.token`으로 exact package만
content-addressed store에 채우고 token 비포함 검사를 통과한 store만 source archive에 싣는다.
Cloud Build는 이 store를 사용하지만 token이나 `.npmrc` credential은 받지 않는다.

현재 WorkflowBundle mode는 `SHADOW`이고 signed contract의 ruleset 의도는 `EVALUATE`다.
실제 보호 provider는 계정 capability readback으로 고른다. Enterprise는 조직 ruleset,
Team은 저장소별 `main` branch protection을 사용한다. Team SHADOW는 mutation 없이
desired/actual diff만 기록하고, 승인된 ACTIVE wave에서만 app ID가 고정된
`Org Contract / Org Contract`, `Seori Review`, strict/up-to-date와 최소 review 정책을
단조 강화한다. 기존 bypass, restriction 또는 더 강한 보호를 보존할 수 없으면
`HUMAN_DECISION_REQUIRED`로 멈춘다.

CANDIDATE bundle은 일반 generator에 넣지 않는다. 전용 trusted canary adapter가 Happy Farm
`1250442131`과 Lizard Tycoon `1265192029`에만 static 및 Android build-only caller 두 개를
생성한다. Android caller는 canary PR 자체의 제한된 `pull_request` trigger로 build evidence를
만들 수 있어 default branch에 workflow가 없을 때도 승격 deadlock이 생기지 않는다. PR보다
먼저 exact candidate central `job_workflow_ref`와 repo/source/plan에 묶인
`CANDIDATE_WIF_PREBIND` 5분·1회 승인을 CAS로 소비하고 shared WIF binding의 etag CAS와
readback을 완료한다. 중앙 callee는 일반 `main` caller 또는 고정 repository ID의 same-repo
canary PR, exact base source·merge ref·workflow execution SHA suffix만 허용한다.

### Xcode Cloud build-only contract

Apple은 GitHub macOS caller를 새로 만들지 않는다. `generateXcodeCloudRunContract`가 exact
repo/source SHA, WorkflowBundle digest, `ciBuildRuns.create`, profile별 `ci_scripts`,
idempotency key를 묶은 `contracts/xcode-cloud-run.schema.json` 문서를 만든다. product와
workflow ID는 자유 입력이 아니라 trusted Backoffice ExternalBinding readback에서 가져오며
`BUILD_ONLY` distribution과 observation ID를 함께 고정한다. Backoffice의 App Store Connect
adapter는 validator가 반환한 deep-frozen snapshot만 소비한다. 이 계약의 `marketUpload`은
`false`이며 심사 제출과 공개 배포는 별도 승인 gate다.

### Platform release gate

static PR check는 signed fleet-approved Platform manifest와 Backoffice observation 부재를
`SHADOW/EVALUATE` 진단으로만 기록한다. release build는
`evaluatePlatformReleaseGate`의 trusted readback adapter가 두 readback을 exact
repo/source/bundle/platform revision에 묶은 5분 receipt로 확인하지 못하면
`FAIL_CLOSED`다. release executor는 `consumePlatformReleaseGateBinding`으로 exact identity,
TTL과 receipt ID/generation durable CAS를 다시 확인한 opaque binding만 사용한다. Android와 Xcode의 이 문서상
경로는 build-only이므로 release 승인을 대체하지 않는다.

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

배너 광고를 사용하는 WebView 앱은 기존 앱별 `VITE_AD_GROUP_ID`를 named secret으로
전달하고 `require_ad_group_id: true`를 설정한다. 중앙 workflow는 누락·공백 값을
거부하고 식별자를 검증·빌드 step에만 전달한다. 광고가 없는 기존 caller는 이 선택적
입력을 생략한다. 광고 식별자와 공용 배포 API 키를 새로 만들거나 서로 대체하지 않는다.

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
