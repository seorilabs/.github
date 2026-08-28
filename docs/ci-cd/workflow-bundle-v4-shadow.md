# WorkflowBundle v4 shadow rollout

## 범위

WorkflowBundle v4는 중앙 static 계약에 Android build-only와 Xcode Cloud build-only 계약을
추가한다. 기존 `@main`, `secrets: inherit`, GitHub-hosted Android/macOS consumer는 즉시
삭제하거나 실패시키지 않는다. `evaluateLegacyWorkflow`가 먼저 observation을 만들고,
ruleset은 계약 상수 `EVALUATE`에 머문다.

이 단계에서 하지 않는 일:

- 조직 secret visibility, WIF IAM, Environment 또는 ruleset 변경
- 기존 caller 수정·삭제와 앱별 bootstrap PR 생성
- Google Play, App Store Connect, AppsInToss 업로드
- Xcode Cloud build 실행, 심사 제출 또는 공개 배포
- WorkflowBundle `APPROVED` 승격

## 불변 bundle

`contracts/workflow-bundle-source.yaml`과 schema는 다음을 한 digest에 묶는다.

- RN/Godot static reusable workflow와 Android Cloud Build reusable workflow의 full source SHA
- checkout, Node, artifact, Google auth, gcloud action의 공식 stable commit SHA와 gcloud 582.0.0
- private static/Android submit ARC label과 live Pod에서 확인한 runner image digest, public PR GitHub-hosted 경계
- Node, pnpm, Godot checksum과 Android builder image digest
- caller 최소 permission, zero-secret, concurrency 계약
- RN `seorilabs/happy-farm`와 Godot `seorilabs/lizard-tycoon`의 별도 static/build run ID와 AAB digest canary gate
- Android RPI submit/fetch와 `seorilabs-ci` x64 Cloud Build 경로
- Apple Xcode Cloud `ciBuildRuns.create`와 profile별 `ci_scripts`
- Platform static shadow와 release fail-closed receipt 계약

APPROVED bundle의 과거 source를 검증할 때는 현재 파일 목록을 강제하지 않는다. 서명된 bundle
자체의 contract/runtime digest path를 fixed GitHub origin의 exact commit에서 다시 읽는다.
따라서 v4 asset 추가가 과거 APPROVED bundle의 복구를 깨지 않는다.
Xcode Cloud validator도 현재 checkout의 schema가 아니라 이 exact-source contract snapshot을
사용하므로 이후 schema가 바뀌어도 과거 APPROVED v4를 재현할 수 있다.

candidate workflow가 만드는 RN/Godot JSON은 schema와 runner/build 계약을 확인하는
`WORKFLOW_BUNDLE_CONTRACT_FIXTURE` probe일 뿐이며 승격 evidence가 아니다. 승격기는 bundle에
고정된 두 canary repo의 독립 static run과 build-only run, 성공 conclusion, exact source와
workflow bundle SHA, Cloud Build ID, builder/config digest, AAB checksum을 trusted GitHub
readback adapter가 모두 확인해야 한다. 이 값들은 APPROVED 서명 원장에도 함께 남는다.

static workflow의 앱 실행 job은 fork pull request이면 package credential을 만들기 전에
skip된다. 격리된 `Org Contract` job은 skipped quality를 성공으로 바꾸지 않고 fail-closed한다.
tokenless public-fork 검증 경로를 별도로 승인하기 전에는 fork 코드를 제한된 package token과
함께 실행하지 않는다.

## Android build-only

caller는 중앙 generator만 만들며 사용자 입력 없이 Backoffice-bound `source_sha`, resolved
`working_directory`, full workflow SHA만 전달한다. secret mapping과 caller runner/step은
없다. callee는 Google WIF 인증 전에 caller가 정확히
`.github/workflows/android-build-only.yml@refs/heads/main`인지와 event ref가 main인지
검증한다. 따라서 별도 branch나 다른 caller가 임의 `source_sha`로 중앙 workflow를 직접
호출해도 인증 단계에 도달하지 못한다. 이 경로의 Environment/WIF를 활성화하기 전에는
managed caller path를 보호하는 ruleset과 Backoffice exact-source parity를 반드시 readback한다.
중앙 workflow는 private repo에서
`seorilabs-rpi-arm64`로 다음만 수행한다.

1. exact source SHA checkout과 tracked credential scan
2. full SHA로 호출된 중앙 workflow identity 확인
3. RN이면 `packages: read` job token으로 exact `@seorilabs/platform-sdk`만 격리 store에 staging하고 token 비포함 확인
4. WIF 인증과 `billing/quota_project=seorilabs-ci` 설정
5. auth credential file과 중앙 checkout을 제외한 source archive 제출
6. digest-pinned x64 builder가 repo-owned `scripts/build-android.sh` 실행
7. 단일 AAB를 GCS에서 회수하고 3일 GitHub artifact로 보관

tracked credential scan은 개인키, GitHub token, AWS access key처럼 소스에 없어야 하는
high-confidence secret만 차단한다. Firebase 웹·모바일 클라이언트 API key는 공개 앱 설정에
포함되는 값이므로 secret으로 오탐하지 않는다. 대신 Backoffice ProviderObservation이
[Firebase API key 권고](https://firebase.google.com/docs/projects/api-keys)에 따라 허용 API,
앱 제한, IAM·Security Rules·App Check 상태를 provider readback으로 검증한다.

private package token은 RPI의 staging child process에만 존재한다. argv, stdout, source archive,
Cloud Build environment에는 전달하지 않는다. Cloud Build는 사전 검증한 content-addressed
store에서 private SDK를 재사용하고 공개 package만 registry에서 내려받는다. pnpm global
virtual store는 끄고 `/workspace/.seorilabs-pnpm-store`를 exact store로 강제해 빌더의 기존
cache나 사용자 npm 설정이 검증 결과에 섞이지 않게 한다.

Cloud Build 실행 SA에는 앱별 build/signing secret 단위 접근만 부여하고 market publisher,
review, role/key 변경 권한을 부여하지 않는다. 따라서 build script가 마켓 작업을 요청해도
credential boundary에서 실패해야 한다. `SEORI_BUILD_MODE=build-only`와
`SEORI_ANDROID_AAB_OUTPUT`은 repo script 계약이다.

## Apple build-only

GitHub macOS workflow를 생성하지 않는다. Backoffice adapter가
`contracts/xcode-cloud-run.schema.json` envelope를 받아 App Store Connect API의
`ciBuildRuns.create`만 호출한다. envelope는 repo numeric ID, exact source SHA, bundle digest,
trusted ExternalBinding readback의 public product/workflow/observation ID와 `BUILD_ONLY`
distribution, immutable tag의 `scmGitReferences` ID와 commit SHA, 실제
`CiBuildRunCreateRequest`의 workflow/sourceBranchOrTag relationship, profile별 `ci_scripts`,
run ID와 idempotency key를 고정한다. 생성 직후 `ciBuildRuns.get` readback의
`sourceCommit.commitSha`, workflow ID와 source reference ID가 envelope와 모두 일치해야만
build evidence가 된다. branch/tag 이동이나 다른 commit 관측은 fail-closed다.
TestFlight 배포·심사·공개 배포는 이 계약 밖의 별도 gate다.

## Platform 접점

static mode에서는 fleet-approved manifest나 Backoffice observation이 아직 없어도 check를
실패시키지 않고 진단을 남긴다. release mode에서는 trusted adapter가 다음을 모두 묶은 5분
receipt를 반환해야 한다.

- repo numeric ID와 full name
- exact app source SHA와 WorkflowBundle source SHA/digest
- Platform source SHA와 contract revision
- 서명 검증된 `FLEET_APPROVED` manifest digest
- current Backoffice observation ID/digest
- 고유 receipt ID, run ID와 CAS generation

하나라도 없거나 불일치하면 `FAIL_CLOSED`다. signer와 provider adapter 구현은 이 계약을
소비하며 secret이나 signature material을 receipt에 추가할 수 없다. release executor는
opaque binding의 exact identity와 TTL을 다시 확인한 뒤 trusted adapter의 receipt ID/generation
durable CAS가 성공한 경우에만 소비한다. WeakMap은 프로세스 내부 재진입 방어일 뿐이며,
여러 worker의 단일 소비 정본은 Backoffice CAS다. CAS 응답이 유실되면 binding은
`UNCERTAIN`으로 남고, 같은 receipt/run의 durable readback이 `CONSUMED` 또는 `AVAILABLE`을
확정한 뒤에만 동일 run을 재개한다. CAS 완료 응답이 와도 receipt TTL을 넘겼으면 실패한다.

## Active 전환 gate

1. candidate workflow의 npm test와 non-promotable RN/Godot contract fixture probe 성공
2. `happy-farm`와 `lizard-tycoon` pilot 각각 별도 static + build-only run 성공
3. source SHA, builder digest, Cloud Build ID, AAB checksum readback
4. WIF condition이 numeric repo ID와 중앙 `job_workflow_ref` full SHA를 제한함을 확인
5. managed Android caller main ref 보호와 runtime caller-ref 거부 테스트
6. ARC scale set의 live imageID가 bundle의 signed digest와 일치함을 readback
7. Cloud Build executor에 market 권한이 없고 secret 단위 IAM만 있음을 readback
8. Xcode Cloud product/workflow ID와 build-only distribution 설정 readback
9. 두 번 연속 legacy/new shadow parity
10. rollback용 이전 bundle SHA와 registry/schema snapshot 복구 검증

이후에도 ruleset Active와 기존 caller 정리는 wave별 별도 승인 작업이다.
