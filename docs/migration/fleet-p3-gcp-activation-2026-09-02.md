# P3 GCP WIF provider 전환 — 2026-09-02 UTC

Cloud Build용 GitHub WIF provider `fleet-p3/github-cloud-build`의 신뢰 `job_workflow_ref`를
WorkflowBundle v5 후보 `2e9b6afd0c0b02f691ecaf1fa0055cadb57e972c`로 전환했다. 직전 SHA
`e21b8da8e45a3379bdae2978522a6ac4b6d7f8f1`은 `wif.supersededWorkflowExecutionShas`로 열거해
exact 쌍 조건만 전환 대상으로 인식했고, 다른 조건은 여전히 `P3_GITHUB_WIF_PROVIDER_DRIFT`다.
계약 변경은 [#102](https://github.com/seorilabs/.github/pull/102)로 병합했다.

## 실제 적용 결과

2026-09-02 12:5x UTC, `seorilabs-ci` 프로젝트 `321365398093`에서 확인했다. 사용자가 승인한
provisioner의 기한부 installer 권한(`p3-installer-20260902`, `2026-09-02T16:00:00Z` 만료)으로
`plan → readback → apply fleet-p3-11a494e936e0 → readback`을 실행했다.

| 확인 대상 | 적용 전 readback | 적용 후 readback |
| --- | --- | --- |
| GitHub provider | 존재, `configurationExact: false` (직전 SHA 쌍 조건), 활성 | 존재, `configurationExact: true`, 활성 |
| MicroK8S provider | exact, 활성 | exact, 활성 |
| WIF pool | exact, ACTIVE | exact, ACTIVE |
| 필수 API | 10/10 | 10/10 |
| 서비스 계정 | 12/12 존재, 비활성 없음 | 12/12 |
| 리소스별 IAM binding | 74/74 | 74/74 |
| 새 정적 키 | 0 | 0 |
| `ready` | false | true |

apply는 provider를 disable → `update-oidc`(새 조건) → 재검증 → enable 순서로 좁혔고 IAM binding은
재확인만 했다. 라이브 provider 조건에는 `@2e9b6af…` 조합 4개만 남았다. 공개 결과와 digest는
[재조회 기록](evidence/fleet-p3-gcp-2026-09-02.json)에 보관한다.

## 함께 확인한 사항

- 두 시범 앱 `internal` Environment의 `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`,
  `SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT`, `SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT`가
  계약의 `cloudBuild.githubActions.repositoryBindings`와 exact 일치한다 (사용자가 직접 설정).
- 마켓 업로드, 심사 제출, 공개 배포, 앱 signing 교체, 정적 키 생성은 하지 않았다.

## 남은 gate

- 두 시범 앱의 실제 build-only run과 artifact 검증: [중앙 #42](https://github.com/seorilabs/.github/issues/42).

## 같은 날 후속 전환 — 5d73a03d, 7790257

시범 빌드 첫 실행에서 드러난 결함(Cloud Build substitution 이스케이프 [#104](https://github.com/seorilabs/.github/pull/104),
STATIC_CHECK 예외 base 결합 [#105](https://github.com/seorilabs/.github/pull/105), ARC 감사 timeout
[#106](https://github.com/seorilabs/.github/pull/106))을 고치면서 후보 SHA를 두 번 더 옮겼다. 같은 기한부 installer
권한(`p3-installer-20260902`, 16:00Z 만료) 안에서 각각 `plan → readback → apply → readback`을 실행했다.

| 전환 | execution SHA | superseded | confirmation | apply | 적용 후 readback |
| --- | --- | --- | --- | --- | --- |
| X2 | `5d73a03dad6102ebef6272ff448eb82f8a58ba03` | `2e9b6af…` | `fleet-p3-00abdc8ff5ab` | exit 1 (`P3_GITHUB_WIF_PROVIDER_MIGRATION_FAILED`, 아래 참고) | exact·active, `ready: true`, binding 74/74 |
| X3 | `7790257716bca71ae865aa11274803520adf13e3` | `5d73a03d…` | `fleet-p3-baef5aa7e307` | exit 0 | exact·active, `ready: true`, binding 74/74 |

X2 apply는 update-oidc와 enable이 반영된 뒤 마지막 재조회에서 일시적 불일치로 실패 코드를 냈다. 직후 별도
readback이 exact·active·`ready: true`였고 라이브 조건에 `@5d73a03d…` 4개 조합만 남아 재적용하지 않았다. X3 전환 뒤
라이브 조건은 `@7790257…` 4개 조합뿐이다. 계약 변경은 [#107](https://github.com/seorilabs/.github/pull/107)로 병합했다.
공개 결과와 digest는 [전환 기록](evidence/fleet-p3-gcp-2026-09-02-transitions.json)에 보관한다. 새 정적 키는 만들지 않았다.

## 세 번째 전환 — 5159ca37, 그리고 첫 build-only 성공

pnpm store dangling 심볼릭 링크 제거([#109](https://github.com/seorilabs/.github/pull/109))를 병합한 뒤 후보를
`5159ca37fde9306e6b5da265f6889ae5782b03bd`(X4)로 옮겼다(`fleet-p3-1064de32d563`, apply exit 0, 적용 후 readback
exact·active·`ready: true`, binding 74/74). 계약 변경은 [#110](https://github.com/seorilabs/.github/pull/110)이다.

X3(`7790257…`) 시점에 lizard-tycoon의 중앙 build-only가 처음으로 끝까지 성공했다.

| 항목 | 값 |
| --- | --- |
| run | [33645367627](https://github.com/seorilabs/lizard-tycoon/actions/runs/33645367627) (PR #536, `refs/pull/536/merge`) |
| Cloud Build | `385fa128-ba8c-4047-bf5a-6ffe114a6343`, builder `godot-android-builder@sha256:b2a9d7a8…` |
| bundle / 설정 | `7790257…`, payloadDigest `sha256:15b4f384…`, ConfigRevision 21 |
| AAB | `app-release.aab` 49,289,785 bytes, sha256 `bc92475649a66699616c…` = provenance `artifactSha256` |
| marketUpload | false |

X3 시점의 static 증거는 `static:godot`(lizard-tycoon, [33645367682](https://github.com/seorilabs/lizard-tycoon/actions/runs/33645367682)),
`static:react-native`(happy-farm, [33644209575](https://github.com/seorilabs/happy-farm/actions/runs/33644209575))였다.
아래 X4 재실행으로 모든 증거를 X4 기준으로 갱신했다.

## X4 기준 두 앱 build-only 재실행

provider가 X4만 신뢰하므로 두 앱의 ACTIVE 설정을 X4로 올리고 후보 실행기로 canary PR을 다시 만들었다.

happy-farm의 첫 X4 실행([33647994835](https://github.com/seorilabs/happy-farm/actions/runs/33647994835), PR #501, Cloud Build
`705ed219-51da-400a-91b1-26d109e0ef0b`)은 앱 `scripts/build-android.sh`가 build-only에서 빈 `SEORI_RELEASE_TAG`의 존재 자체를
거부해 step 0에서 멈췄다. 중앙 `rn-android-build-only-v2.yaml`은 tag 실행이 아니어도 `SEORI_RELEASE_*` 세 값을 빈 값으로 항상
export하며 lizard-tycoon 스크립트는 이미 그 계약을 따른다. 앱 쪽 수정은 [happy-farm#502](https://github.com/seorilabs/happy-farm/pull/502)이고,
병합 후 감사 예외 binding을 새 main `69d29018…`으로 다시 묶은 ConfigRevision 17을 활성화해 재실행했다.

| 항목 | lizard-tycoon | happy-farm |
| --- | --- | --- |
| run | [33650716595](https://github.com/seorilabs/lizard-tycoon/actions/runs/33650716595) (PR #537) | [33651252122](https://github.com/seorilabs/happy-farm/actions/runs/33651252122) (PR #503) **TIMEOUT** |
| Cloud Build | `d2fc1717-effa-4b28-8c05-edd0a518be4f`, `godot-android-builder@sha256:b2a9d7a8…` | `fb0cf593-13d7-4b26-8df9-8982ea21d808`, `rn-android-builder@sha256:ed73c852…`, E2_STANDARD_2, 2400s 소진 |
| bundle / 설정 | `5159ca37…`, payloadDigest `sha256:cfcf2cb6…`, ConfigRevision 23 | `5159ca37…`, ConfigRevision 17 |
| app source | `e673e0dd…` | `69d29018…` |
| AAB | 49,289,793 bytes, sha256 `c1ca51c43b88249ad338…` = provenance `artifactSha256` | 없음 (Gradle 네이티브 4 ABI CMake 단계에서 40.3분 경과) |
| marketUpload | false | false |

happy-farm 두 번째 실행은 계약 검증·`pnpm install`·모바일 품질 검사를 통과한 뒤 Gradle 네이티브 단계에서 중앙 `rn-android-build-only-v2.yaml`의
`timeout: 2400s`에 걸렸다. 앱 production 설정 `cloudbuild-android.yaml`은 같은 machineType에 7200s를 쓴다. 중앙 timeout을 7200s로 올리는
[#112](https://github.com/seorilabs/.github/pull/112)는 새 후보(X5)를 만들므로 provider 전환이 한 번 더 필요하다.

static 증거도 X4로 갱신했다: `static:godot`([33650716200](https://github.com/seorilabs/lizard-tycoon/actions/runs/33650716200), ConfigRevision 23),
`static:react-native`([33651252134](https://github.com/seorilabs/happy-farm/actions/runs/33651252134), ConfigRevision 17). 승인(APPROVED)에는 `static:capacitor`, `static:ait-web` 증거가 더 필요하다.
provenance 원본은 `evidence/fleet-p3-*-2026-09-02.json`에 보관하며 X3 기록은 `…-transitions.json`의 `previous`에 남긴다.
마켓 업로드는 하지 않았다.

## 네 번째 전환 — 2fee6630 (RN Cloud Build timeout 7200s)

happy-farm build-only가 2400s에 걸려 [#112](https://github.com/seorilabs/.github/pull/112)로 timeout을 7200s로 올리자
후보가 `2fee6630a8a2e79128cbf6055087bf9f9402810d`(X5, registry record `cmtkcl6bf3n6ruv01uw6t0fz4`)로 바뀌었다.
계약 전환은 [#114](https://github.com/seorilabs/.github/pull/114)이다. 16:00Z에 만료된 installer 권한은 사용자가
`p3-installer-20260903`(2026-09-03T04:00Z 만료)으로 다시 부여했다. 그 사이 한 번 부여한 `p3-installer-20260902b`는
조건 만료 시각(21:00Z)이 부여 시점보다 앞서 효력이 없었고, 만료된 binding은 그대로 둔다.

2026-09-02 23:45Z에 `readback`(github provider `configurationExact: false`, `ready: false`) → `apply fleet-p3-9a7eecf513a7`
(exit 0) → `readback`(exact·active·`ready: true`, binding 74/74, 새 정적 키 0) 순서로 전환했다. 라이브 조건에는 `@2fee6630…`
조합 4개만 남았다.

두 앱의 ACTIVE 설정을 X5로 올렸다(happy-farm ConfigRevision 18, lizard-tycoon 26). lizard-tycoon은 그 사이
`scheduler:desired-state-backfill`이 매시 27분에 `config-source-auto-rebase` revision(24, 25)을 자동 생성·활성화해
`expectedLatestRevision` 충돌이 났고, DB의 최신 revision을 다시 읽어 26으로 만들었다. main도 `c7f8ae97…`(#540, #541)로
이동해 실행기 PLAN의 `sourceSha`를 그 값으로 맞췄다. 재실행 결과는 아래에 이어서 기록한다.
