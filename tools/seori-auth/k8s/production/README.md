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
| `imagePullPolicy` | `Always` 또는 `IfNotPresent` |
| `nodeSelector` | 검증된 RPI5를 고르는 label 한 개 |
| `stateClaimName` | 사전에 검증된 encrypted PVC 이름 |
| `trustedWorkers` | namespace/pod exact match label을 각각 한 개씩 가진 selector |
| `providerControlPlane` | exact `backofficeClientSpiffeId`, 고정 `/internal/control-plane/provider-grants` scope, Backoffice worker 전용 namespace/pod exact selector |
| `egressProxy` | namespace/pod exact selector와 TLS proxy port |
| `roles` | `broker`, `passwordLoader`, `totpSigner` 세 binding |

각 role binding은 `configMapName`, `tlsSecretName`, `egressTlsSecretName`, public
`googleServiceAccount`, WIF `wifAudience`, exact `secretAccessConfigSha256`만 가집니다.
config/TLS/egress TLS/Google identity/config digest는 세 role 사이에서 반드시 달라야 합니다.
renderer는 GSA, audience, digest를 container의 public startup binding으로 고정합니다. runtime은
마운트된 `secret-access.json`의 digest와 impersonation target을 다시 읽어 일치하지 않으면
readiness 전에 중단합니다. 같은 WIF provider audience를 쓰더라도 IAM subject는 Kubernetes
namespace와 ServiceAccount까지 고정합니다.
provider control-plane의 SPIFFE ID와 endpoint scope도 runtime config, immutable startup
argument, Pod annotation에 각각 고정합니다. broker client allowlist에 exact Backoffice
SPIFFE가 없거나 scope가 `/auth/*`로 바뀌면 readiness 전에 중단합니다. 이 binding은
ServiceAccount에 Kubernetes API 권한을 추가하지 않으며 생성되는 Role은 계속 `rules: []`입니다.

renderer가 참조하지만 생성하지 않는 외부 객체는 다음뿐입니다.

- role별 ConfigMap - `runtime.json`, `secret-access.json`; broker는 추가로 `policy.json`,
  `run-attestation.pub`
- role별 service mTLS Secret - `ca.crt`, `tls.crt`, `tls.key`
- role별 egress mTLS Secret - `ca.crt`, `tls.crt`, `tls.key`
- broker 전용 encrypted PVC

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
현재 구현 작업은 live RBAC, Secret Manager IAM, TLS material, PVC 또는 provider 계정을
생성·변경하지 않습니다.

projected identity volume은 고정 mount
`/var/run/seori-auth/projected-identity`와 고정 leaf `token`만 제공합니다. Kubernetes의
atomic symlink ABI는 native helper가 Linux `openat2`의 beneath/no-magiclink/no-cross-mount
규칙으로 검증합니다. token은 fixed child의 FD4로만 상속되고 한 번 읽은 직후 닫힙니다.
