# Fleet P3 runtime 전환 기록

기준 source는 `origin/main@c328d9bf55f31ba11f53ef06071cc7b76d283617`이다. 이 문서는
2026-08-28 KST live readback과 P3 공개 계약을 분리해 기록한다. secret, capability, 승인
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
- `scripts/fleet/bootstrap-p3-github.mjs`: 사람 전용 App approval gate, additive custom property,
  pilot 값, Evaluate ruleset의 기본 dry-run과 exact readback
- `tests/fleet-p3-runtime.test.mjs`: strict schema, 최소 권한 분리, secret 비노출, RBAC 0권한,
  exact pilot과 fail-closed manifest 검증

## 적용 순서와 gate

1. Auth Broker restricted namespace를 만든 뒤 전체 foundation을 server dry-run하고 적용한다.
   Namespace, ServiceAccount, RBAC, NetworkPolicy, Certificate 상태를 readback한다.
2. GCP 관리자가 5개 service account와 최소 IAM/WIF binding을 계약대로 생성한다. 정적 key는
   만들지 않고 각 공개 identity와 binding을 API로 readback한다.
3. RPI5 storage의 encrypted-at-rest를 증명하거나 암호화 storage class를 제공한다.
4. private GHCR pull identity를 등록된 shared credential에서 secret 출력 없이 주입하고,
   provider signer와 egress proxy를 먼저 배포한다.
5. workload와 PVC를 배포한 뒤 건강 상태와 mTLS peer를 readback하고 fake account canary에서
   origin, TTL, 1회성, repository·namespace binding을 검증한다.
6. 조직 owner가 공식 URL로 GitHub App을 만들고 webhook secret을 입력한다. App installation
   identity와 webhook delivery를 readback한 뒤 custom properties와 Evaluate ruleset을 적용한다.
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
Cloud Build service agent의 user-specified executor token 생성, GitHub multi-tenant issuer의 조직
condition, private Kubernetes issuer의 공개 JWKS upload는 각각 Google 공식
[user-specified service account](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts),
[deployment pipeline WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[Kubernetes WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes) 경계를 따른다.

```bash
node scripts/fleet/bootstrap-p3-gcp.mjs
node scripts/fleet/bootstrap-p3-gcp.mjs apply fleet-p3-c328d9bf55f3
node scripts/fleet/bootstrap-p3-gcp.mjs readback
node scripts/fleet/bootstrap-p3-gcp.mjs rollback fleet-p3-rollback-c328d9bf55f3
```

현재 provisioner에는 apply 권한이 없어 GCP 객체는 아직 생성되지 않았다. 2~6번은 권한 또는
선행 보안 gate가 충족되기 전까지 완료로 기록하지 않는다.

GitHub 조직 변경도 기본 dry-run이며 App 생성은 자동화하지 않는다. 조직 owner는 아래 App
approval gate를 먼저 처리하고, `admin:org` 권한으로 additive property/ruleset bootstrap을 한
번 승인한 뒤 readback한다.

```bash
node scripts/fleet/bootstrap-p3-github.mjs
node scripts/fleet/bootstrap-p3-github.mjs apply fleet-github-c328d9bf55f3
node scripts/fleet/bootstrap-p3-github.mjs readback
```
