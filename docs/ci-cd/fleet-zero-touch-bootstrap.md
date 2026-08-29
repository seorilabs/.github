# Fleet zero-touch repository bootstrap

## 현재 범위

`@seorilabs/repo-contract/bootstrap`은 GitHub App webhook에서 새 저장소를 안전하게 등록하는 fail-closed 계획 코어다. `@seorilabs/repo-contract/trusted-executor`는 이 계획을 GitHub App installation token 경계 안에서 실행하고 operation별 provider readback 뒤에만 완료하는 운영 코어다.

이 저장소의 구현은 실제 GitHub App installation, custom property schema, 조직 secret, WIF IAM 또는 ruleset을 변경하지 않는다. Backoffice의 durable claim/receipt 저장소와 실제 provider transport를 연결하기 전에는 live mutation을 허용하지 않는다.

지원 이벤트는 `repository.created`, `repository.renamed`, `repository.archived`, `repository.unarchived`, 기본 브랜치 `push`다. 서명 검증 전에는 JSON을 파싱하거나 provider readback을 호출하지 않는다.

## 신뢰 경계

1. trusted loader가 `shared/github/backoffice-app-webhook` logical credential을 Buffer로 대여한다.
2. HMAC SHA-256을 constant-time 비교하고 secret Buffer를 즉시 zeroize한다.
3. webhook의 숫자 organization·installation·repository ID와 `seorilabs` owner를 검증한다.
4. GitHub provider readback으로 repository ID, 현재 이름, visibility, archive, default branch와 exact HEAD SHA를 다시 확인한다.
5. delivery claim은 `CLAIMED`, 장애 후 `RESUME`, durable 저장 완료 뒤 `COMPLETED`만 허용한다.
6. Backoffice의 exact source SHA caller binding과 fleet-approved WorkflowBundle binding으로만 thin caller를 생성한다.
7. secret-free 계획 전체를 durable queue에 원자적으로 저장하고 동일 plan digest를 readback한 뒤 완료한다.

`completeDelivery`는 delivery 상태와 plan을 같은 트랜잭션에 기록해야 한다. 저장 실패 시 delivery를 완료 처리하면 안 되며, 재전달은 `RESUME`으로 같은 idempotent plan을 다시 만든다.

## 생성하고 실행하는 작업

- Backoffice repository observation 또는 archive
- `fleet-managed`, `fleet-profile`, `fleet-state`, `fleet-ruleset=shadow|active` custom property 정합화
- protected branch만 허용하는 `internal` Environment 정합화
- `.github/workflows/org-contract.yml` bootstrap PR 생성 또는 기존 PR 갱신
- `internal` Environment의 공개 WIF provider, Cloud Build submitter/executor identity 정합화
- 이미 등록된 조직 secret의 selected repository visibility 연결
- 숫자 repository ID와 중앙 `job_workflow_ref@full-sha`를 compound principal로 고정한 shared-provider WIF binding
- Enterprise 조직 ruleset 또는 Team 저장소별 branch protection의 SHADOW/ACTIVE reconciliation

`attachFleetProvisioningOperations`는 secret 값 대신 logical credential ID와 GitHub Secret 이름만 받는다. WIF도 shared provider resource name, service account email, exact 중앙 workflow SHA만 받는다. callee가 읽는 세 GitHub Actions 변수는 비밀이 아닌 공개 identity지만 중앙 desired state의 exact catalog binding으로만 받는다. Environment variable binding과 WIF binding은 같은 logical credential, revision, `internal` Environment를 가져야 하며 하나만 누락되면 계획을 거부한다. unknown field, secret 값, 중복 binding은 schema 이전에 거부한다. 보호 강화 승인과 credential provisioning 승인은 서로 다른 1회용 receipt여야 한다.

WorkflowBundle v4는 Android build-only caller와 Xcode Cloud run envelope의 중앙
generator/validator도 제공하지만, webhook의 기본 zero-touch plan은 static
`org-contract.yml`까지만 자동 생성한다. Environment variable, secret visibility와 WIF
operation은 Backoffice의
ACTIVE desired state를 읽은 trusted reconciler가 `attachFleetProvisioningOperations`로 별도
추가한다. non-promotable contract fixture probe와 실제 pilot의 두 번 연속 shadow parity,
WIF·Cloud Build IAM readback, Xcode Cloud workflow readback이 끝난 뒤 별도 wave에서 추가한다.
따라서 이 변경만으로 기존 release caller, secret visibility, ruleset 또는 provider 상태는
바뀌지 않는다.

작업별 idempotency key는 repository ID, operation kind와 canonical payload를 묶는다. 이미 열린 bootstrap PR은 갱신하며 새 PR을 만들지 않는다. 다른 자율 PR이 있으면 `WAITING_FOR_PR_SLOT`으로 중단해 repo당 동시 자율 PR 1개를 지킨다.

다음 조건은 추측하거나 우회하지 않는다.

- discovery 후보 0개 또는 여러 개
- ACTIVE config 부재
- 비어 있는 저장소
- 기본 브랜치가 `main`이 아님
- public repository의 별도 runner 정책 부재
- webhook·provider readback의 ID, 이름 또는 SHA 불일치

## trusted executor 경계

`createGitHubAppTrustedAdapter`는 operation마다 숫자 installation ID와 repository ID 하나, 필요한 permission만 지정해 단기 installation token을 발급한다. token Buffer는 provider callback에서만 사용하고 작업 직후 zeroize한다. 모델·worker가 호출하는 executor 결과에는 token, provider response body, 오류 상세가 없다.

각 operation은 다음 순서를 지킨다.

1. durable queue의 exact plan digest·operation count가 `EXECUTABLE`인지 trusted readback
2. 모든 operation payload가 plan 최상위 repository ID·이름·source SHA를 가리키는지 검증
3. organization, installation, repository ID와 exact default-branch SHA readback
4. 5분·1회용 approval CAS와 durable idempotency claim 또는 완료 operation readback
5. trusted adapter 내부 mutation
6. operation별 공개 상태와 repository identity 재확인
7. secret-free receipt digest를 durable 저장한 뒤 완료

apply 성공 여부가 불명확하거나 source SHA가 바뀌면 완료하지 않는다. 같은 idempotency key로 provider readback부터 재개한다. 이미 완료한 operation도 provider 상태가 없으면 성공으로 간주하지 않는다.

durable receipt는 현재 target의 충족 사실만 고정한다. shared WIF provider/service-account의 etag, 조직 secret의 다른 selected repository, custom property의 다른 key, Environment의 관련 없는 공개 변수처럼 다른 fleet 작업이 늘릴 수 있는 superset 상태는 stable satisfaction witness에서 제외한다. 대신 현재 provider 전체 observation은 별도 `readbackDigest`로 남긴다. 따라서 다른 repo를 추가해도 기존 완료 작업은 mutation 없이 replay되지만 target binding 자체가 사라지면 fail-closed한다.

## 운영 adapter 권한

GitHub App installation token은 매 operation마다 숫자 repository ID 한 개와 필요한 permission만 지정해 발급한다. GitHub는 installation access token을 repository ID와 permission으로 더 좁힐 수 있다.

- repository readback: Metadata read, Contents read
- bootstrap PR: Contents write, Pull requests write, Workflows write
- repository custom property: Repository custom properties write
- Environment와 Environment variables: Environments write
- 조직 secret selected repository: Organization secrets write
- Enterprise ruleset capability/readback: Organization administration read
- Team branch protection readback/apply: Repository administration read/write

readback token은 같은 permission의 `read`만 사용하고 mutation token과 분리한다. WIF mutation은 GitHub token을 전달하지 않고 별도 trusted GCP adapter가 수행한다.

정적 caller는 secret을 받지 않으므로 조직 secret 가시성이나 WIF를 bootstrap 단계에서 추가하지 않는다. release workflow가 중앙 desired state에 활성화된 뒤 별도 승인된 adapter가 세 공개 Environment variable과 named secret visibility를 설정하고, 숫자 owner ID와 `(job_workflow_ref, 숫자 repository ID)` 쌍으로 WIF를 구성한다. `secrets: inherit`는 허용하지 않는다.

공식 API 근거:

- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub App installation token scoping](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Repository custom properties](https://docs.github.com/en/rest/repos/custom-properties)
- [Deployment environments](https://docs.github.com/en/rest/deployments/environments)
- [Actions environment variables](https://docs.github.com/en/rest/actions/variables#create-or-update-an-environment-variable)
- [OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)

## WorkflowBundle 승인 경계

`@seorilabs/repo-contract/trusted-publisher`는 WorkflowBundle 승인을 GitHub executor와 분리한다. worker는 승인 key를 받지 않고 canonical signing payload와 logical ID `shared/workflow-bundle/approval-signing`만 signer adapter에 보낸다. 서명은 등록된 public key로 로컬 검증하고, registry publish 후 별도 readback이 exact bundle/source/digest/state를 반환해야 `APPROVED`가 된다.

저수준 `promoteWorkflowBundle`도 private key 입력을 받지 않고 `trustedApprovalSigner` callback과 등록된 public key만 받는다. production wiring은 signer와 registry publish/readback을 함께 고정하는 `createTrustedWorkflowBundlePublisher`만 사용하며 모델·worker process에 private key를 mount하지 않는다.

## 보호 provider와 rollout

계정 capability가 Enterprise이면 `ORG_RULESET`, Team이면 `REPO_BRANCH_PROTECTION`만 허용한다. SHADOW는 두 provider 모두 mutation 없이 desired/actual diff observation만 남긴다. ACTIVE는 별도 1회용 승인 receipt가 있을 때 exact `main`, trusted check app ID, strict/up-to-date, 최소 review 정책만 단조 강화한다. 기존 check, review count, code-owner review, bypass actor, restriction과 넓은 보호 설정은 보존한다. provider가 설정을 표현하지 못하거나 CAS 뒤 digest가 달라지면 삭제·완화하지 않고 `HUMAN_DECISION_REQUIRED`로 끝낸다. 기존 ruleset provisioning gate schema는 signed 과거 plan 검증을 위해 유지하되, 새 provisioning plan은 보호 승인과 credential 승인을 분리한 v2 gate만 생성한다.

## Candidate canary bootstrap

`@seorilabs/repo-contract/trusted-candidate-canary`는 APPROVED 전용 일반 generator와 분리된 유일한 CANDIDATE 실행 경로다. 중앙 source SHA의 contract/runtime bytes와 integrity를 매 단계 다시 읽고, Backoffice ACTIVE manifest도 exact repo/source/config revision으로 다시 읽는다. 대상은 Happy Farm `1250442131`과 Lizard Tycoon `1265192029` 두 개뿐이며 static과 Android build-only thin caller 외 파일, `secrets: inherit`, 임의 runner·steps는 거부한다.

PR mutation 전에 `CANDIDATE_WIF_PREBIND` 목적의 5분·1회 승인 receipt를 CAS로 소비한다. 승인은 organization·repo·app source SHA·candidate bundle digest·candidate source SHA·central `job_workflow_ref`·plan digest를 모두 고정한다. shared WIF provider의 기존 binding과 두 etag를 먼저 읽고, exact etag CAS 적용 뒤 다시 `BOUND`인지 확인한 경우에만 GitHub App이 PR을 생성한다. 완료 replay는 같은 consumed approval과 WIF/PR exact readback을 사용하며 이미 존재하는 IAM binding이나 PR을 중복 생성하지 않는다.

Android caller는 생성 PR의 해당 파일 변경에만 반응한다. 중앙 reusable workflow는 일반 경로에서는 exact `main` caller만, candidate 경로에서는 고정 repository ID·same-repo head·exact base source SHA·`refs/pull/<number>/merge`·workflow execution SHA suffix가 모두 맞는 PR만 허용한다. repository-scoped GitHub App token, plan generation, 5분 operation lease, idempotent readback을 모두 통과해야 완료된다.

## 운영 전 필수 gate

- GitHub App webhook secret을 Auth Broker trusted loader와 연결
- delivery claim·plan 저장을 Backoffice의 durable queue transaction과 연결
- GitHub provider transport에 fixed API origin, redirect 거부, API version 고정
- mutation 직전 repository ID·source SHA·open PR count 재검증
- custom property schema를 조직에서 승인 후 생성
- 실제 GitHub account plan과 check app ID readback, ACTIVE wave 승인 receipt 연결
- candidate WIF prebind 승인 발급과 durable CAS store, shared provider/service-account transport 연결
- private RN/Godot canary에서 5분 등록, 10분 bootstrap PR 또는 정확한 `needs_input` 검증
- APPROVED Android caller는 `.github/workflows/android-build-only.yml@refs/heads/main`, CANDIDATE canary caller는 allowlisted PR branch로 구분해 runtime ref 검증
- ARC live Pod imageID와 signed WorkflowBundle runner digest 일치 확인
- 두 번의 shadow parity 전에는 ruleset Active 전환 금지

P3 GitHub App bootstrap의 공개 요청 계약은 `contracts/fleet-p3-runtime.yaml`에 고정한다. 새
Fleet App은 만들지 않고 active `seorilabs-backoffice` App `4124446`, installation
`142120077`을 재사용한다. 기존 permission/event union을 줄이거나 대체하지 않으며 필요한 최소
증설과 installation acceptance만 조직 owner gate로 둔다. 두 credential은 기존 SealedSecret
ciphertext와 `shared/k8s/sealed-secrets-recovery`에서 신규 key 생성 없이 offline 복구하고
`shared/github/backoffice-app-private-key`, `shared/github/backoffice-app-webhook`으로 분리 등록하는
별도 backup/restore 승인 gate다. credential 값은 URL·manifest·로그·파일에 넣지 않는다. App
identity와 permission/event union이 exact해진 뒤에도 조직 custom property schema와 Evaluate
ruleset은 각각 admin 권한으로 적용하고 API readback이 exact 계약과 일치해야 완료다. 공식 API
경계는 [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app),
[조직 custom properties](https://docs.github.com/en/rest/orgs/custom-properties),
[조직 rulesets](https://docs.github.com/en/rest/orgs/rules)를 따른다.

offline recovery는 `scripts/fleet/github-credential-recovery.mjs`의 trusted adapter만 허용한다.
adapter는 Sealed Secrets nonce-prefixed payload를 process-local memory에서만 해제한다. signed
Security.framework native helper의 exact code identity, unattended ACL, item-not-found/readback,
batch compensation이 검증되기 전에는 `HUMAN_REAUTH_REQUIRED`로 중단하고 raw value나
`security -w` CLI를 사용하지 않는다. 검증 뒤에도 App public identity, 공개 fingerprint, 복구
전후 backup/restore만 반환한다. GitHub apply는 이 private key로
short-lived installation token을 발급하는 exact capability executor가 별도 검증되기 전까지
`P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED`로 중단하며 ambient personal token으로 우회하지 않는다.
이 CLI의 API client 자체도 GET만 허용하며 contract의 ready flag를 바꿔도 ambient `gh` mutation
경로가 열리지 않는다.

helper source와 adapter는 각각 `scripts/fleet/native/github-keychain-helper.swift`,
`scripts/fleet/github-keychain-native-store.mjs`다. adapter는 외부에서 고정한 helper SHA-256과 Apple
Team ID를 요구하고, helper는 같은 Team ID의 non-ad-hoc designated requirement를 자체 검증한다.
두 exact target 외의 service/account, secret이 포함된 argv·environment, prompt 가능한 ACL, readback
불일치, 부분 batch 보상 실패는 모두 fail-closed다. fixture 및 unsigned compile gate 통과만으로
`blocked_unverified`를 `ready`로 바꾸지 않는다.
