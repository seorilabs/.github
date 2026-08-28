# Fleet P3 runtime 전환 기록

P3 WorkflowBundle provenance 기준 source는
`f831208f120086c8897e0ac8beaa569eee5202e7`이다. 이 문서는
2026-08-28~29 KST live readback과 P3 공개 계약을 분리해 기록한다. secret, capability, 승인
receipt, lease token은 기록하지 않는다.

## 적용 전 readback

- 로컬 credential catalog preflight는 104개 entry, warning 2개, error 0개였다. 신규 P3
  logical ID 5개는 공개 identity만 가진 `planned` 상태며 활성 credential이 아니다.
- `seorilabs-ci`에는 default compute service account만 있었고 현재 provisioner에는 service
  account 생성, project IAM 조회·변경, WIF pool 조회·변경 권한이 없었다.
- Kubernetes에는 `auth-broker` namespace, `provider-execution-signer`,
  `seori-auth-egress-proxy`가 없었다. cert-manager와 sealed-secrets controller는 Ready였다.
- 유일한 storage class `microk8s-hostpath`의 RPI5 backing path는 NVMe ext4였지만 LUKS 또는
  dm-crypt mapping이 확인되지 않았다. encrypted-at-rest PVC gate는 미충족이다.
- 고정 Auth Broker image는 성공한 `Seori Auth Image` run `33157801494`의 private GHCR digest
  `sha256:d8fabaa5e79711d2a4cddd4d70af8d8f17e96143a5b281bccf3f0ee89a1ea457`다.
- GitHub token에는 `admin:org` scope가 없었다. 조직 custom property schema는 비어 있었고,
  조직 ruleset 조회·생성은 권한 부족이었다. 기존 repository ruleset `PR Rule`은 `.github`와
  `happy-farm`에서 readback됐고 `lizard-tycoon`에는 적용되지 않았다.

## 구현 정본

- `contracts/fleet-p3-runtime.yaml`: GitHub App/webhook, custom properties, Evaluate ruleset,
  Cloud Build submitter/executor, Auth Broker 공개 identity·network·TLS·storage gate
- `contracts/fleet-p3-runtime.schema.json`: exact organization, pilot, permission, identity와
  fail-closed 상태의 strict schema
- `scripts/fleet/render-p3-runtime.mjs`: secret-free 공개 payload와 Kubernetes foundation renderer
- `scripts/fleet/bootstrap-p3-gcp.mjs`: 기본 dry-run, exact 5 service accounts, dedicated GitHub와
  MicroK8s WIF condition, 최소 resource IAM, idempotent resume, pool/provider drift readback과
  provider disable 기반 권한 회수 rollback
- `scripts/fleet/bootstrap-p3-github.mjs`: 기존 Backoffice App exact identity와 permission/event
  union readback, 사람 전용 최소 증설 gate, additive custom property, pilot 값, Evaluate ruleset의
  기본 dry-run과 exact readback
- `scripts/fleet/github-credential-recovery.mjs`: nonce-prefixed SealedSecret hybrid ciphertext를
  process-local memory에서 해제하되 signed native Keychain helper 전에는 write를 차단하는 adapter
- `scripts/fleet/bootstrap-p3-secret-manager.mjs`: broker/password/TOTP별 네 exact secret version과
  secret-level accessor binding의 기본 dry-run, two-phase apply, readback, provider-disable rollback
- `tests/fleet-p3-runtime.test.mjs`: strict schema, 최소 권한 분리, secret 비노출, RBAC 0권한,
  exact pilot과 fail-closed manifest 검증

## 적용 순서와 gate

1. Auth Broker restricted namespace를 만든 뒤 전체 foundation을 server dry-run하고 적용한다.
   Namespace, ServiceAccount, RBAC, NetworkPolicy, Certificate 상태를 readback한다.
2. GCP 관리자가 5개 service account와 최소 IAM/WIF binding을 계약대로 생성한다. 정적 key는
   만들지 않고 각 공개 identity와 binding을 API로 readback한다.
3. RPI5 storage의 encrypted-at-rest를 증명하거나 암호화 storage class를 제공한다.
4. 개인 `shared/github/operator`는 desired pull identity로 재사용하지 않는다. 조직 전용
   machine-user packages reader 또는 digest/signature가 검증된 public package 중 하나를 승인한
   뒤, renderer가 세 Pod 모두에 exact `imagePullSecrets`를 고정하는지 확인하고 provider signer와
   egress proxy를 먼저 배포한다.
5. workload와 PVC를 배포한 뒤 건강 상태와 mTLS peer를 readback하고 fake account canary에서
   origin, TTL, 1회성, repository·namespace binding을 검증한다.
6. 새 App을 만들지 않고 live active `seorilabs-backoffice` App `4124446`, installation
   `142120077`을 재사용한다. 조직 owner는 기존 permission/event union을 보존한 최소 증설과
   installation acceptance만 처리한다. App identity와 union readback 뒤 custom properties와
   Evaluate ruleset을 적용한다.
7. 두 pilot에서 두 번의 shadow parity와 rollback rehearsal이 끝날 때까지 ruleset은 Active로
   바꾸지 않는다.

2026-08-28 KST에 1번 foundation을 적용했다. `kubectl diff`는 0이고 Certificate 8개는 모두
Ready이며 3개 KSA의 Secret `get/list/watch` 9개 조합은 모두 `no`다. workload와 PVC는 0개다.
공개 ConfigMap은 계약과 동일한 SHA-256으로 readback했다. 다음 명령은 exact 객체만 겨냥하는
rollback dry-run이며 실제 삭제는 별도 승인에서만 수행한다.

```bash
node scripts/fleet/render-p3-runtime.mjs auth-broker-foundation-rollback |
  kubectl delete --dry-run=server -f -
```

GCP bootstrap의 기본 실행은 mutation 없는 plan이다. 적용은 아래 공개 confirmation을 요구하고,
부분 실패 뒤 같은 명령을 재실행하면 existing exact 객체는 no-op한다. rollback은 apply 전부터
존재했는지 구분할 수 없는 IAM binding을 제거하지 않고 두 exact provider만 disable한다. 신규
token exchange는 차단되지만 이미 발급된 access token은 자체 만료까지 유효하다. 이후
같은 apply는 configuration이 exact인 disabled provider를 안전하게 re-enable하며 provider drift,
pool disabled·metadata/state drift에서는 fail-closed한다. readback은 pool active 상태, 5개 공개
identity, 두 active provider condition, 15개 exact binding이 모두 일치할 때만 `ready: true`다.
apply와 rollback은 GitHub와 Kubernetes provider를 모두 read-only preflight한 뒤에만 provider
mutation 단계로 넘어가므로 두 번째 provider drift에서도 첫 번째 provider를 변경하지 않는다.
Cloud Build service agent의 user-specified executor token 생성, GitHub multi-tenant issuer의 조직
condition, private Kubernetes issuer의 공개 JWKS upload는 각각 Google 공식
[user-specified service account](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts),
[deployment pipeline WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[Kubernetes WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes) 경계를 따른다.

```bash
node scripts/fleet/bootstrap-p3-gcp.mjs
node scripts/fleet/bootstrap-p3-gcp.mjs apply '<plan이 반환한 contract digest confirmation>'
node scripts/fleet/bootstrap-p3-gcp.mjs readback
node scripts/fleet/bootstrap-p3-gcp.mjs rollback '<plan이 반환한 rollback confirmation>'
```

현재 provisioner의 project IAM readback은 권한 부족으로 실패하므로 GCP 객체의 존재나 정합성을
판정하지 않는다. 2~6번은 권한 또는 선행 보안 gate가 충족되기 전까지 완료로 기록하지 않는다.

2026-08-29 readback에서 App은 active·unsuspended, organization 전체 저장소 installation이었다.
현재 permission은 `actions:write`, `checks:read`, `contents:write`, `issues:write`, `members:read`,
`metadata:read`, `pull_requests:read`이고 event는 `issues`, `issue_comment`, `pull_request`, `push`,
`workflow_run`이다. 계약은 이 상태를 줄이지 않고 `pull_requests:write`, `workflows:write`,
`repository_custom_properties:write`, `environments:write`, `administration:write`,
`organization_administration:write`, `organization_custom_properties:admin` 및 `repository` event만
union에 추가한다. 증설 및 installation acceptance 뒤 exact readback 전에는 GitHub bootstrap
apply가 custom property/ruleset을 변경하지 않는다.

private key와 webhook의 local canonical source는 현재 없다. exact source
`seorilabs/seorilabs-backoffice@8d7162f352454b892ff749ac0d4061c492d7781f`의
`k8s/backoffice-sealedsecret.yaml` ciphertext와 active
`shared/k8s/sealed-secrets-recovery`만 복구 근거다. `GITHUB_PRIVATE_KEY`와
`GITHUB_WEBHOOK_SECRET`을 각각 `shared/github/backoffice-app-private-key`,
`shared/github/backoffice-app-webhook`으로 분리 등록하는 작업은 새 key를 생성하지 않는 offline
사람 승인 gate다. source digest 및 encrypted key 존재, recovery credential active, target ID
부재, 복구 전 backup/restore 검증을 모두 확인해야 시작할 수 있다. plaintext는 stdout, argv,
environment, log, 파일, commit, PR을 통과할 수 없다. trusted adapter는 nonce-prefixed
AES-256-GCM/RSA-OAEP ciphertext와 recovery key를 process-local memory에서 처리한다. signed
Security.framework native helper의 exact code identity, unattended ACL, locked/permission/item-not-found
분리, batch compensation이 검증되기 전에는 `HUMAN_REAUTH_REQUIRED`이며 `security -w` CLI로
우회하지 않는다. 등록 후 logical ID active, App identity
exact, 복구 후 backup/restore 검증을 readback해야 완료다. 이번 변경에서는 복호화·등록·cluster
Secret 생성 등 외부 mutation을 수행하지 않았다.

같은 readback에서 개인 `shared/github/operator`의 private package metadata 접근은 확인됐지만
조직 canonical identity로 승격하지 않는다. GitHub의 non-Actions private GHCR pull 경계에 따라
조직 전용 machine-user PAT classic 또는 digest/signature 검증 후 public package 전환 중 하나를
별도 승인해야 한다. `auth-broker` namespace에서 `seori-auth-ghcr-pull` Secret은 존재하지 않았고
workload·PVC도 0개였다. production renderer는 이제 세 Pod에 exact
`imagePullSecrets`를 필수로 넣어 node cache 의존을 거부하지만, Secret 생성과 workload apply는
등록 identity·backup/restore 승인 및 공개 readback 뒤 별도 외부 mutation gate로 남아 있다.

GitHub 조직 변경도 기본 dry-run이다. apply confirmation은 reusable workflow execution pin
`c328d9b`가 아니라 canonical App/operation plan digest에 결합한다. WorkflowBundle provenance는
1단계 source `f831208`에, reusable workflow execution은 동일 bytes가 검증된 `c328d9b`에 각각
고정한다. GitHub WIF condition은 numeric owner ID와 Happy Farm/RN, Lizard Tycoon/Godot의
`repository_id + job_workflow_ref` 쌍만 허용하며 교차 조합을 허용하지 않는다. `internal`
Environment에는 중앙 desired state의 공개 WIF provider와 Cloud Build submitter/executor SA를
같은 binding revision으로 reconcile한다. 조직 owner는 permission expansion approval을 먼저
처리해야 하며, 복구 private key로 short-lived installation token을 만드는 trusted executor와
exact capability readback이 검증되기 전에는 ambient personal token apply가 항상 차단된다.
bootstrap과 trusted executor는 같은 공개 policy generator를 사용한다. provider mapping은
`repository_id + job_workflow_ref`로, IAM member는 `attribute.repository_id`로 통일되며 provider
condition이 두 exact pair만 token exchange하도록 제한한다. 별도의
`environment/seorilabs_capability` mapping이나 generic workflow regex를 같은 provider에
덮어쓰는 경로는 제거했다.

```bash
node scripts/fleet/bootstrap-p3-github.mjs
node scripts/fleet/bootstrap-p3-github.mjs apply '<plan이 반환한 contract plan digest confirmation>'
node scripts/fleet/bootstrap-p3-github.mjs readback
```

Auth Broker Secret Manager apply는 별도 role-change 승인이다. 네 secret은 각각 version `1`만
허용하고 broker는 journal MAC/Browser Vault, password-loader는 fake password, TOTP signer는
fake seed만 읽는다. 값은 raw key, base64url fake password, canonical base32 fake TOTP로 생성한다.
fd3 native writer의 공개 identity, CRC32C, backup/restore를 승인한
별도 gate이며 이 저장소는 raw value를 생성하거나 전달하지 않는다. apply는 GitHub/Kubernetes
provider와 네 secret/version을 먼저 읽고 drift나 cross-role accessor가 하나라도 있으면 mutation
0건으로 중단한다. rollback은 두 provider만 preflight하고, secret이 사라진 비상 상황에도
pre-existing 여부를 알 수 없는 IAM을 제거하지 않은 채 Kubernetes provider를 disable한다.

```bash
node scripts/fleet/bootstrap-p3-secret-manager.mjs
node scripts/fleet/bootstrap-p3-secret-manager.mjs apply '<plan이 반환한 confirmation>'
node scripts/fleet/bootstrap-p3-secret-manager.mjs readback
node scripts/fleet/bootstrap-p3-secret-manager.mjs rollback '<plan이 반환한 rollback confirmation>'
```

현재 provisioner의 project IAM readback은 `PERMISSION_DENIED`이므로 resource 부재로 판단하지
않는다. 실제 네 secret/version, secret-level IAM, WIF 활성화, workload와 fake canary는 모두
미적용·미검증 상태다.
