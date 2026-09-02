# Fleet P3 runtime 전환 기록

2026-09-01 UTC GCP 기반 설정의 실제 적용·재조회 결과는
[P3 GCP 설치 완료 기록](fleet-p3-gcp-activation-2026-09-01.md)을 따른다. 아래 초기 5개 계정·15개
권한 및 권한 부족 설명은 당시 기록이다. 현재 실행 범위는 `bootstrap-p3-gcp.mjs plan`과
기계 판독 계약으로 확인한다.

P3 runtime 초기 전환의 WorkflowBundle provenance 기준 source는
`9583e0d21a4a2b23d0b93c4deedb74b6b467aadf`이다. 이 문서는
2026-08-28~29 KST live readback과 P3 공개 계약을 분리해 기록한다. secret, capability, 승인
receipt, lease token은 기록하지 않는다.

## 적용 전 readback

- 로컬 credential catalog preflight는 103개 entry, warning 0개, error 0개였다. 신규 P3
  logical ID 5개는 공개 identity만 가진 `planned` 상태며 활성 credential이 아니다.
- `seorilabs-ci`에는 default compute service account만 있었고 현재 provisioner에는 service
  account 생성, project IAM 조회·변경, WIF pool 조회·변경 권한이 없었다.
- Kubernetes에는 `auth-broker` namespace, `provider-execution-signer`,
  `seori-auth-egress-proxy`가 없었다. cert-manager와 sealed-secrets controller는 Ready였다.
- 유일한 storage class `microk8s-hostpath`는 RPI5 local volume을 제공한다. block-device 암호화
  여부는 더 이상 P2 gate가 아니다. secret-bearing durable state는 application envelope로만
  저장하고, 공개 journal은 비밀 비노출 serializer와 HMAC chain으로 제한한다.
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
- `scripts/fleet/github-credential-recovery.mjs`: 공식 SealedSecret hybrid ciphertext를
  process-local memory에서 해제하되 signed native Keychain helper 전에는 write를 차단하는 adapter
- `scripts/fleet/bootstrap-p3-secret-manager.mjs`: broker/password/TOTP별 네 exact secret version과
  secret-level accessor binding의 기본 dry-run, two-phase apply, readback, provider-disable rollback
- `scripts/fleet/verify-p2-state-envelope.mjs`: application envelope 구현 계약과 exact Retain
  PV/PVC의 read-only live readback. host storage를 탐색하거나 provisioning하지 않음
- `tests/fleet-p3-runtime.test.mjs`: strict schema, 최소 권한 분리, secret 비노출, RBAC 0권한,
  exact pilot과 fail-closed manifest 검증

## 적용 순서와 gate

1. Auth Broker restricted namespace를 만든 뒤 전체 foundation을 server dry-run하고 적용한다.
   Namespace, ServiceAccount, RBAC, NetworkPolicy, Certificate 상태를 readback한다.
2. GCP 관리자가 5개 service account와 최소 IAM/WIF binding을 계약대로 생성한다. 정적 key는
   만들지 않고 각 공개 identity와 binding을 API로 readback한다.
3. Browser Vault AES-256-GCM, journal의 쓰기 전 공개-schema 검증/HMAC chain을 검증하고,
   RPI5 Retain PV/PVC가 exact Bound identity인지 read-only로 확인한다.
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

2026-09-01 KST에는 RPI5의 기존 불변 reboot receipt를 exact source
`8889621b356268bd7bcec7fefa828485f6252721`로 재검증했다. 결과는
`HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED`, receipt digest
`1395adf535b12060963d2cb9b84cf7d8df1279968d0d0e813ecc204d37813444`였고 기존 receipt를
덮어쓰지 않았다. verified host-encryption binding을 포함한
`auth-broker-public-bindings-190f9c1f6834`를 server dry-run 뒤 적용했으며 후속 `kubectl diff`는
0이다. readiness audit에서 `STATE_HOST_ENCRYPTION_GATE_BLOCKED`는 해소됐다. 남은 진단은
`REGISTRY_GATE_BLOCKED`, `SECRET_MANAGER_GATE_BLOCKED`,
`STATE_APPLICATION_PROTECTION_GATE_BLOCKED`와 과거 불변 public binding ConfigMap 2개다. 과거
ConfigMap은 rollback 문서의 삭제 승인 원칙에 따라 자동 삭제하지 않았다.

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

2026-08-29 기준 private key와 webhook의 local canonical source는 없었다. exact source
`seorilabs/seorilabs-backoffice@8d7162f352454b892ff749ac0d4061c492d7781f`의
`k8s/backoffice-sealedsecret.yaml` ciphertext와 active
`shared/k8s/sealed-secrets-recovery`만 복구 근거다. `GITHUB_PRIVATE_KEY`와
`GITHUB_WEBHOOK_SECRET`을 각각 `shared/github/backoffice-app-private-key`,
`shared/github/backoffice-app-webhook`으로 분리 등록하는 작업은 새 key를 생성하지 않는 offline
사람 승인 gate다. source digest 및 encrypted key 존재, recovery credential active, target ID
부재, 복구 전 backup/restore 검증을 모두 확인해야 시작할 수 있다. plaintext는 stdout, argv,
environment, log, 파일, commit, PR을 통과할 수 없다. trusted adapter는
AES-256-GCM/RSA-OAEP ciphertext와 recovery key를 process-local memory에서 처리한다.
공식 wire 형식은 `RSA 길이 → RSA ciphertext → AES ciphertext와 tag`이며 nonce prefix는 없다.
각 값마다 새로운 AES key를 사용하므로 GCM nonce는 12바이트 zero이고, strict scope의 OAEP
label은 `namespace/name`이다. 근거는 [공식 HybridEncrypt/HybridDecrypt](https://github.com/bitnami-labs/sealed-secrets/blob/54c805dbf4ab7fae87cce28648da252e8c69347f/pkg/crypto/crypto.go)와
[EncryptionLabel](https://github.com/bitnami-labs/sealed-secrets/blob/54c805dbf4ab7fae87cce28648da252e8c69347f/pkg/apis/sealedsecrets/v1alpha1/sealedsecret_expansion.go)이다.
`scripts/fleet/native/github-keychain-helper.swift`와
`scripts/fleet/github-keychain-native-store.mjs`는 두 고정 logical ID만 받는 binary-stdin 경계,
자체 code-signature 검증, exact self-only ACL readback, UI 금지, item-not-found 분리와 부분 batch
compensation을 구현한다. 외부 `CredentialBinding`에 고정된 helper SHA-256·Apple Team ID와 helper가
검증한 designated requirement가 모두 일치해야 adapter가 열린다. macOS의 modern access-control
flag는 실행 binary의 designated requirement를 ACL로 표현하지 못하므로, helper는 Security.framework의
`SecAccess` application ACL을 사용하고 모든 민감 authorization이 exact self 하나·prompt flag 0인지
다시 읽어 fail-closed한다. 기본 계약의 `blocked_unverified`와 `HUMAN_REAUTH_REQUIRED`는
검증되지 않은 새 실행 환경을 위한 거부 기본값이며, `security -w` CLI로 우회하지 않는다.
실제 승인 run은 signed helper binding과 local preflight를 확인한 뒤에만 복구 adapter를 연다.
등록 후 logical ID active, App identity exact, 복구 후 backup/restore 검증을 readback해야 완료다.
2026-09-02 승인 복구 결과는 아래 별도 실행 기록을 따른다. 이 복구는 cluster Secret 생성이나
GitHub mutation executor 활성화를 포함하지 않는다.

코드 게이트는 macOS에서 fixture helper와 production 분기의 ad-hoc 서명 거부를 함께 검증한다.

```bash
node scripts/fleet/build-github-keychain-helper.mjs --fixture
node scripts/fleet/build-github-keychain-helper.mjs --compile-gate
node --test tests/github-keychain-native-store.test.mjs tests/fleet-p3-runtime.test.mjs
```

production build는 승인된 코드서명 identity와 공개 Team ID를 명시해야 하며, build script가 hardened
runtime 서명·strict verification·helper self-attestation을 모두 통과한 뒤에만 산출물을 교체한다.
그 다음 별도 승인 run에서 public helper binding을 고정하고 `preflight`의 exact item-not-found를
확인한다. 이 단계까지는 Keychain write도 credential catalog mutation도 수행하지 않는다.

실제 승인 복구 진입점은 `scripts/fleet/run-github-credential-recovery.mjs`다. 승인 operation,
canonical credential root, source checkout, signed helper의 경로·SHA-256·Team ID,
process-hardening native module의 경로·SHA-256만 CLI 인수로 받는다. `ulimit -S -c 0`,
`ulimit -H -c 0`과 `SEORI_AUTH_NATIVE_LAUNCHED=1`로 시작하고 native module이 실제 core limit과
debugger attach 차단을 확인한 뒤에만 recovery key를 읽는다. 비밀값 인수·환경변수는 없다.
등록은 기존 catalog를 수정하지 않고 `catalog/github-backoffice-app.yaml`과 두 공개 reference를
원자적으로 추가한다. 실패하면 이번 실행이 생성했고 변경되지 않은 파일·Keychain item만 보상한다.
복구 전후 각각 local·BeeStation 백업의 임시 복원 검증을 모두 요구한다.
Keychain reference만 백업하고 원본 암호문은 GitHub에만 남기는 상태를 허용하지 않는다.
`github/recovery/backoffice-<source SHA>.sealedsecret.yaml`에 exact ciphertext를 함께 보존하므로,
GitHub와 원래 checkout이 없어도 archive의 recovery key와 ciphertext로 기존 값을 복구할 수 있다.
기존 snapshot의 digest가 다르면 덮어쓰지 않는다. 이 파일은 암호문이며 plaintext 파일이 아니다.

macOS 실제 실행 검증에서 확인한 두 native 제약도 fail-closed로 처리한다. 32-bit frame 길이는
64-bit `Int.max`를 `UInt32`로 좁히지 않고 비교한다. `SecAccessCreate`의 기본 owner ACL과
encryption ACL은 그대로 사용하지 않고 모든 simple entry를 exact self로 지정한다. 삭제는
복구 실패 보상에 필요한 restricted entry에만 추가한다. 생성 전에는 ACL을 메모리에서 검증하고,
생성 후에는 item reference의 `SecKeychainItemCopyAccess`로 저장된 ACL을 읽는다. 근거는
[Apple SecAccessCreate](https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:))와
[SecKeychainItemCopyAccess](https://developer.apple.com/documentation/security/seckeychainitemcopyaccess(_:_:))다.

### 2026-09-02 기존 GitHub 인증 복구 완료

사용자가 승인한 기존 두 자격증명의 local canonical 복구를 완료했다. 새 key 생성·회전 없이
원본 SealedSecret에서 복구하여 signed helper의 exact self ACL로 저장했고, 실제 값 일치 및
UI 없는 Keychain readback을 통과했다. 두 logical ID는 active이고 catalog는 118건·경고 0·오류 0이다.
복구 전후 및 원본 암호문 보완 후에 각각 local·BeeStation archive의 임시 복원을 검증했다.
원본 암호문 두 값은 Backoffice `fa8d478f097fde64f315e7eeafeac5c40c46b871`의 현재 소스와 같다.

[공개 실행 근거](evidence/fleet-p3-github-credential-recovery-2026-09-02.json)는 source/helper/backup
digest와 검증 상태만 기록한다. 이 결과로 같은 credential recovery 승인을 다시 요청하거나
복구를 재실행하지 않는다. App JWT를 이용한 새 authenticated readback, 정확히 제한된 mutation
executor, 두 pilot의 신규 등록·build-only 실증은 별도 미완료 항목이다. P3 전체 완료를 뜻하지 않는다.

같은 readback에서 개인 `shared/github/operator`의 private package metadata 접근은 확인됐지만
조직 canonical identity로 승격하지 않는다. GitHub의 non-Actions private GHCR pull 경계에 따라
조직 전용 machine-user PAT classic 또는 digest/signature 검증 후 public package 전환 중 하나를
별도 승인해야 한다. `auth-broker` namespace에서 `seori-auth-ghcr-pull` Secret은 존재하지 않았고
workload·PVC도 0개였다. production renderer는 이제 세 Pod에 exact
`imagePullSecrets`를 필수로 넣어 node cache 의존을 거부하지만, Secret 생성과 workload apply는
등록 identity·backup/restore 승인 및 공개 readback 뒤 별도 외부 mutation gate로 남아 있다.

GitHub 조직 변경도 기본 dry-run이다. apply confirmation은 reusable workflow execution pin이
아니라 canonical App/operation plan digest에 결합한다. 2026-08-30 v5 전환 뒤 WorkflowBundle
source와 reusable workflow execution은 모두 exact commit
`d1d672553ee57befab01675680597cedeb345496`로 고정한다. GitHub WIF condition은 numeric owner
ID와 Happy Farm/RN, Lizard Tycoon/Godot, Babycare/RN, Cycle Pair/RN의
`repository_id + job_workflow_ref` 네 쌍만 허용하며 교차 조합을 허용하지 않는다. `internal`
Environment에는 중앙 desired state의 공개 WIF provider와 Cloud Build submitter/executor SA를
같은 binding revision으로 reconcile한다. 조직 owner는 permission expansion approval을 먼저
처리해야 하며, 복구 private key로 short-lived installation token을 만드는 trusted executor와
exact capability readback이 검증되기 전에는 ambient personal token apply가 항상 차단된다.
bootstrap과 trusted executor는 같은 공개 policy generator를 사용한다. provider mapping은
`repository_id + job_workflow_ref`로, IAM member는 `attribute.repository_id`로 통일되며 provider
condition이 네 exact pair만 token exchange하도록 제한한다. 별도의
`environment/seorilabs_capability` mapping이나 generic workflow regex를 같은 provider에
덮어쓰는 경로는 제거했다.

GitHub OIDC audience는 `google-github-actions/auth@v3`가 별도 입력 없이 요청하는
`https://iam.googleapis.com/<exact full provider resource>`로 고정한다. 조직 URL custom
audience는 현재 e860 workflow bytes의 기본 요청과 달라 STS에서 거부되므로 사용하지 않는다.
renderer는 numeric project, pool, provider 경로에서 파생한 exact audience만 허용한다. 또한
cross-project `gcloud builds submit`이 staging bucket 존재 확인 중 `storage.buckets.list`를
호출하므로 submitter에는 `seorilabs-ci` project의 `roles/storage.bucketViewer`를 명시한다.

GCP bootstrap은 Cloud Build, IAM, IAM Credentials, Resource Manager, Security Token Service,
Artifact Registry, Cloud Storage, Logging, Secret Manager, Service Usage API의 활성 상태를
공개 이름으로 함께 readback한다. 승인된 apply는 provider drift를 먼저 검사한 뒤 누락 API만
활성화하며, rollback은 여러 workload가 공유하는 API를 끄지 않고 exact provider만 disable한다.

기존 cross-product condition은 알려진 legacy condition, mapping, issuer, audience가 모두 exact일
때만 이관한다. active provider는 먼저 disable하고 legacy 상태를 다시 읽은 뒤 pairwise condition으로
축소하며, disabled exact readback을 통과한 뒤에만 다시 enable한다. 알 수 없는 drift는 provider를
수정하지 않고 중단한다.

GitHub App bootstrap, trusted executor, candidate canary와 exact-source readback의 REST header는
모두 `2026-03-10`으로 통일했다. 이 값은 내부 계약 날짜만이 아니라 GitHub가 현재 지원하는 REST
API version이다. [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10)

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

2026-08-30에는 runtime 계약을 breaking major `schemaVersion: 2`로 올리고 block-device 암호화
의무를 application-layer envelope로 대체했다. Browser Vault는 AES-256-GCM envelope만 저장하고,
durable journal은 secret-free 공개 control/audit schema를 HMAC chain으로 인증하며 쓰기 전에 같은
strict validator를 통과해야 한다. volume verifier는 host나 block device를 읽지 않고 existing
PV/PVC를 `kubectl get`으로만 읽어 exact Bound identity, RPI5 node affinity와 `Retain`을 확인한다.
missing/partial/drift/`Delete`는 mutation 없이 fail-closed하며 create/delete/patch는 별도 승인이다.
실제 live PV/PVC readback은 아직 수행하지 않았으므로 rollout status는
`protection.status: blocked_unverified`로 유지한다.

같은 application envelope 계약의 journal checkpoint는 static head 설정에서 Backoffice durable
CAS로 전환했다. public binding은 `seori-auth-production`, exact provider-control-plane SPIFFE,
`JOURNAL_FSYNC_THEN_CHECKPOINT_CAS`, `READBACK_FIRST`로 고정한다. local journal append가 fsync된 뒤
next checkpoint exact readback까지 확인되어야 mutation이 완료되며, 불명 결과 뒤 재시작은 trusted
head의 직계 자식 한 건만 deterministic idempotent CAS로 복구한다. 실제 Backoffice DB/API와 mTLS
transport 중 client 코드는 고정 signer origin/DNS/SPIFFE/route와 genesis opaque expectedDigest
분리까지 구현했다. production serve는 이 adapter를 직접 주입하며 inbound service certificate와
분리된 `seori-auth-journal-checkpoint-client-tls` 실행 복제본 또는 Backoffice authority가 없으면
credential 접근과 lease 발급 전에 fail-closed한다. renderer는 이 Secret을 생성·동기화하지 않는다.
Backoffice migration 배포와 actual certificate SAN/key/mode/authority readback은 별도 운영 gate이고,
이를 리소스 부재로 추측하지 않는다.

같은 날 후속 review에서 PV/PVC 실측 결과를 production startup과 결합하기 위해 runtime 계약을
breaking major `schemaVersion: 3`으로 올렸다. verifier는 ambient kubeconfig나 사용자 HOME을
사용하지 않고 canonical explicit kubeconfig와 실행별 0700 임시 HOME/cache만 사용한다. 성공
readback은 PV/PVC UID·resourceVersion, state contract digest와 observed digest를 공개
attestation으로 고정한다. production renderer는 이 attestation을 필수로 받고, broker 전용
initContainer가 Kubernetes API에서 같은 PV/PVC를 다시 `get`해 exact 일치한 뒤에만 marker를 쓴다.
Kubernetes API token은 initContainer에만 mount하고 main/factor에는 mount하지 않는다. broker
ServiceAccount 권한은 두 exact `resourceNames`의 `get`만, API egress는
`10.152.183.1/32:443`만 허용한다. readiness/liveness도 같은 marker digest를 다시 확인하므로
`protection.status: verified` 자기 선언이나 render 이후 PV/PVC substitution만으로 READY가 되지
않는다. 이 변경은 PV/PVC를 생성하거나 적용하지 않는다.
