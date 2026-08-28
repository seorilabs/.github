# Production manifest 생성 경계

이 디렉터리의 `*.yaml`은 과거 경로를 보존하는 comment-only marker이며 Kubernetes 객체를
포함하지 않습니다. 운영 객체의 유일한 생성기는
[`../../scripts/render-production-k8s.mjs`](../../scripts/render-production-k8s.mjs)입니다.
renderer는 secret 값을 읽거나 출력하지 않고 하나의 JSON `List`만 stdout에 씁니다.

## Public deployment config

입력은 canonical absolute path의 regular JSON 파일이어야 합니다. 최상위 필드는 다음과
같으며 추가 필드는 거부됩니다.

| 필드 | 계약 |
| --- | --- |
| `schemaVersion` | 정수 `1` |
| `namespace` | 고정값 `auth-broker` |
| `image` | registry와 `@sha256:` digest가 포함된 immutable ARM64 image |
| `imageProvenance` | `seorilabs/.github` source SHA, image workflow/run, `linux/arm64`, `imageDigest`의 exact binding |
| `imagePullPolicy` | `Always` 또는 `IfNotPresent` |
| `registry` | 명시적 `PUBLIC` 또는 `PACKAGES_READER`; mode가 없거나 readback 상태가 미검증이면 중단 |
| `nodeSelector` | 검증된 RPI5를 고르는 label 한 개 |
| `stateClaimName` | 사전에 검증된 encrypted PVC 이름 |
| `trustedWorkers` | namespace/pod exact match label을 각각 한 개씩 가진 selector |
| `providerControlPlane` | signer ServiceAccount의 exact `backofficeClientSpiffeId`, 고정 `/internal/control-plane/provider-grants` scope, Backoffice signer Pod 전용 namespace/pod exact selector |
| `egressProxy` | namespace/pod exact selector와 TLS proxy port |
| `roles` | `broker`, `passwordLoader`, `totpSigner` 세 binding |

각 role binding은 `configMapName`, `tlsSecretName`, `egressTlsSecretName`, public
`googleServiceAccount`, WIF `wifAudience`, exact `secretAccessConfigSha256`만 가집니다.
`allowedSecretManagerResources`는 broker의 journal MAC/Browser Vault version `1`, password
loader의 fake password version `1`, TOTP signer의 fake seed version `1`로 exact 분리합니다.
config/TLS/egress TLS/Google identity/config digest는 세 role 사이에서 반드시 달라야 합니다.
renderer는 GSA, audience, digest를 container의 public startup binding으로 고정합니다. runtime은
마운트된 `secret-access.json`의 digest와 impersonation target을 다시 읽어 일치하지 않으면
readiness 전에 중단합니다. 같은 WIF provider audience를 쓰더라도 IAM subject는 Kubernetes
namespace와 ServiceAccount까지 고정합니다.
provider control-plane의 SPIFFE ID와 endpoint scope도 runtime config, immutable startup
argument, Pod annotation에 각각 고정합니다. broker client allowlist에 exact Backoffice
SPIFFE가 없거나 scope가 `/auth/*`로 바뀌면 readiness 전에 중단합니다. 이 binding은
ServiceAccount에 Kubernetes API 권한을 추가하지 않으며 생성되는 Role은 계속 `rules: []`입니다.

Registry binding은 다음 두 모드 외에는 허용하지 않습니다.

- `PUBLIC`: `{ "mode": "PUBLIC", "visibilityStatus": "VERIFIED_PUBLIC" }`만 허용합니다.
  생성된 세 Pod에는 `imagePullSecrets` key 자체가 존재하지 않습니다. package public readback과
  exact digest provenance 검증은 deployment config를 활성화하기 전의 외부 gate입니다.
- `PACKAGES_READER`: `imagePullSecretName=seori-auth-ghcr-pull`,
  `credentialId=shared/github/packages-reader`, `catalogStatus=ACTIVE`,
  `kubernetesStatus=VERIFIED`만 허용합니다. 개인 operator credential이나 이름이 같은 미검증
  Kubernetes Secret은 거부합니다.

`image`의 digest, `imageProvenance.imageDigest`, source SHA, workflow run이 하나의 public
binding입니다. 이 tuple은 schema와 `public-image-binding.mjs`가 함께 고정하며 public config가
다른 유효 SHA/run ID를 자기선언해도 거부합니다. image를 만든 commit과 digest를 먼저 승격하고
다음 source revision에서 contract와 code를 함께 갱신하는 two-phase 절차를 사용합니다. 현재
source HEAD를 image source로 추측하지 않습니다.

renderer가 참조하지만 생성하지 않는 외부 객체는 다음뿐입니다.

- role별 ConfigMap - `runtime.json`, `secret-access.json`; broker는 추가로 `policy.json`,
  `run-attestation.pub`
- role별 service mTLS Secret - `ca.crt`, `tls.crt`, `tls.key`
- role별 egress mTLS Secret - `ca.crt`, `tls.crt`, `tls.key`
- broker 전용 encrypted PVC
- private GHCR pull Secret - `PACKAGES_READER`일 때만 세 Pod에 동일한 exact
  `imagePullSecrets`로 참조

ConfigMap에는 secret 값 대신 logical credential ID, numeric Secret Manager resource version,
public origin/account identity, immutable executable path와 checksum만 둡니다. TLS private key는
Kubernetes 실행 복제본이지만 worker에는 mount하지 않습니다. password loader GSA는 password
resource만, TOTP signer GSA는 TOTP seed resource만 `access`할 수 있어야 합니다. 어느
ServiceAccount에도 Kubernetes Secret `get/list/watch` 권한을 주지 않습니다.
factor binding에는 Secret Manager resource name을 두지 않으며, factor가 요청할 수 있는
logical credential partition과 `secret-access.json.allowedResources`가 정확히 일치해야 합니다.

## 생성과 검증

`tools/seori-auth`에서 실행합니다.

```sh
node scripts/render-production-k8s.mjs \
  --config=/absolute/path/to/public-deployment.json > /tmp/seori-auth-rendered.json
kubectl apply --dry-run=client --validate=false -f /tmp/seori-auth-rendered.json
```

실제 cluster의 server dry-run, 아홉 RBAC `can-i=no`, WIF/IAM readback, egress proxy allowlist,
PVC encryption과 fake-account login canary를 모두 통과한 뒤에만 별도 승인 작업에서 apply합니다.
private GHCR pull Secret이 namespace에 존재하고 예상 registry identity에서 생성됐다는 공개
readback이 없으면 workload apply를 중단합니다. renderer가 `imagePullSecrets`를 생략한 manifest는
`PUBLIC` verified mode가 아닌 한 node image cache가 있더라도 운영 계약에 맞지 않습니다.
현재 구현 작업은 live RBAC, Secret Manager IAM, TLS material, PVC 또는 provider 계정을
생성·변경하지 않습니다.

projected identity volume은 고정 mount
`/var/run/seori-auth/projected-identity`와 고정 leaf `token`만 제공합니다. Kubernetes의
atomic symlink ABI는 native helper가 Linux `openat2`의 beneath/no-magiclink/no-cross-mount
규칙으로 검증합니다. token은 fixed child의 FD4로만 상속되고 한 번 읽은 직후 닫힙니다.

## RPI5 non-secret image canary

Secret Manager, provider 계정, PVC를 연결하기 전에는 별도 one-shot renderer로 image 자체의
built-in canary만 실행합니다.
입력 JSON은 active immutable public binding의 `image`, `imageProvenance`, `canary`를 exact-copy하고
고정 `schemaVersion: 1`, `namespace: auth-broker`를 사용합니다. `registry`는 live readback 뒤 위의
최소 실행 shape로 정규화합니다. fleet desired-state의 blocked catalog/Secret 상태를
ACTIVE/VERIFIED로 추측해 바꾸거나 human-gate metadata를 실행 입력으로 복사하지 않습니다.

```sh
node scripts/render-nonsecret-canary-k8s.mjs \
  --config=/absolute/path/to/public-canary.json > /tmp/seori-auth-canary.json
kubectl apply --dry-run=client --validate=false -f /tmp/seori-auth-canary.json
node scripts/execute-nonsecret-canary-k8s.mjs \
  --config=/absolute/path/to/public-canary.json
```

render 결과는 검토용이며 `kubectl apply` 대상으로 사용하지 않습니다. executor만
`vzyx-cluster`에서 ServiceAccount, NetworkPolicy, Job을 exact GET하고, 없는 객체에 한해 server
dry-run 뒤 `create`합니다. create가 AlreadyExists 또는 결과 불명으로 끝나면 다시 mutation하지 않고
GET으로 전환합니다. 기존 Job이 있는데 support object가 없거나 하나라도 drift하면 중단합니다.

renderer는 전용 `seori-auth-canary` ServiceAccount의 empty pull binding, RPI5 node, `restricted`
security context, read-only root filesystem, tmpfs runtime, ServiceAccount token 미마운트,
ingress/egress 전부 차단, `backoffLimit: 0`, `podReplacementPolicy: Failed`를 고정합니다. executor는
실제 admitted Pod도 다시 읽습니다. PUBLIC이면 `imagePullSecrets`와 registry credential annotation이
없어야 하고 PACKAGES_READER이면 canonical `seori-auth-ghcr-pull` 하나만 있어야 합니다.

Job 이름과 `seorilabs.io/idempotency-key`는 image digest, code-approved image source provenance,
registry binding, canary contract version의 canonical SHA-256으로 결정됩니다. 완료·실패·결과 불명
Job이 이미 있으면 삭제·apply·재생성하지 않고 같은 Job과 Pod를 readback합니다. Job에는 TTL을 두지
않으며 Backoffice가 occurrence를 기록하기 전까지 marker로 보존합니다. 결과 불명은
`READBACK_FIRST`, 이미 존재하는 occurrence는 `READBACK_ONLY`입니다.

성공 stdout의 유일한 허용값은 아래 JSON 한 줄과 마지막 LF(`\n`)를 포함한 exact bytes입니다. raw log를 화면에 출력하거나 변수·파일에
보관하지 않고 stdin-only verifier로 직접 보내며, verifier의 공개 digest 결과만 기록합니다.

```text
{"state":"CANARY_OK","secretExposed":false}
```

executor가 fixed `kubectl` child의 log stdout을 128 byte로 제한한 뒤 code-owned verifier의 stdin으로
직접 전달합니다. verifier는 argv를 받지 않고 exact 한 줄이 아니면 원문을 반사하지 않은
`canary_output_not_allowlisted`만 반환합니다. 성공 시 executor stdout에는 공개 state, Job 이름,
idempotency key, image/output digest만 남습니다.

허용 SHA-256은 `db69575cac8240a6fb6946f05c32a1ad59d6b58b430b62d99fa2dfa1cea05591`입니다.
