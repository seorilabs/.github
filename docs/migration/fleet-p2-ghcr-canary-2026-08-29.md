# Fleet P2 GHCR와 non-secret canary gate

기준 source는 `seorilabs/.github@6e18b189d112f23270426cd88b3f906969103b75`다. 이 문서는
2026-08-29 KST의 secret-free readback과 다음 배포 계약을 기록한다. credential 값, Kubernetes
Secret data, Secret Manager payload는 조회하지 않았다.

## Live readback

- `auth-broker`에는 restricted namespace, 세 ServiceAccount, 0-rule RBAC, Service 세 개,
  Ready Certificate 여덟 개, default-deny/broker/factor NetworkPolicy가 있다.
- Pod, Deployment, StatefulSet, PVC와 Service endpoint는 0개다. `auth-egress`,
  `release-workers`, `provider-execution-signer`도 없다.
- 세 ServiceAccount의 Kubernetes Secret `get/list/watch` 아홉 조합은 모두 `no`다.
- GHCR package는 private이다. anonymous exact-digest pull은 `401 Unauthorized`이고
  `auth-broker/seori-auth-ghcr-pull`은 없다. 다른 namespace의 `registry-pull-cred`는 canonical
  identity를 증명하지 못한 실행 복제본이므로 재사용하지 않는다.
- `shared/github/operator`는 개인 operator identity라 production pull credential로 승격하지
  않는다. `shared/github/packages-reader`는 catalog에 없다.
- 최신 성공 image run `33190683201`은 ARM64 built-in canary를 통과했고
  `ghcr.io/seorilabs/seori-auth@sha256:b5c5ee63ecc3f16e90013e8f6f8727d6c7dc9f4812ba1a1805165bb7413cd515`를
  source `6e18b189d112f23270426cd88b3f906969103b75`에서 발행했다.
- 이 source SHA, workflow, run ID, platform, digest의 조합은 schema와 runtime code가 함께 소유하는
  immutable approved binding이다. public config가 형식만 맞는 다른 SHA/run ID를 자기선언할 수 없으며,
  다음 image 승격은 contract와 code revision을 함께 요구한다.
- live immutable public ConfigMap은 이전 source/image를 가리킨다. 고정 이름을 덮어쓰지 않고
  canonical binding SHA-256 suffix를 가진 새 immutable ConfigMap으로 승격해야 한다.

## Registry mode

production과 non-secret canary renderer는 mode가 없으면 중단한다.

- `PUBLIC`은 `visibilityStatus=VERIFIED_PUBLIC`만 허용하며 Pod spec에서
  `imagePullSecrets`를 완전히 제거한다.
- `PACKAGES_READER`는 `shared/github/packages-reader`, `seori-auth-ghcr-pull`, catalog
  `ACTIVE`, Kubernetes readback `VERIFIED`의 exact 조합만 허용한다.

현재 package visibility 변경과 신규 machine-user/PAT 생성은 모두 수행하지 않았다. PUBLIC 전환
또는 PACKAGES_READER credential 생성은 조직 owner의 별도 선택 gate다.

## One-shot canary

canary는 image 자체의 built-in `canary` command만 실행하며 Secret Manager, provider, ConfigMap,
PVC를 참조하지 않는다. 전용 `seori-auth-canary` ServiceAccount의 pull binding은 비어 있고
ServiceAccount token도 마운트하지 않는다. RPI5, read-only root filesystem, non-root UID/GID,
RuntimeDefault seccomp, capabilities `ALL` drop, tmpfs runtime/state, ingress/egress deny,
`backoffLimit: 0`, `podReplacementPolicy: Failed`가 고정된다.

Job 이름과 full idempotency annotation은 image digest, source provenance, registry binding,
canary contract version의 canonical SHA-256에서 파생한다. executor는 ServiceAccount,
NetworkPolicy, Job을 먼저 GET한다. Job이 없을 때만 server dry-run 뒤 `create`하고, AlreadyExists나
결과 불명은 다시 create하지 않고 exact readback한다. 기존 Job은 완료·실패·결과 불명 모두
재실행하지 않는다. 성공 output은 raw log를 반사하지 않는 stdin-only verifier에서 아래 한 줄의
hash와 exact-match해야 한다.

```text
{"state":"CANARY_OK","secretExposed":false}
```

SHA-256은 `db69575cac8240a6fb6946f05c32a1ad59d6b58b430b62d99fa2dfa1cea05591`다.
이번 변경은 render와 readback-first executor까지 구현하지만 실제 canary Job은 실행하지 않았고,
package visibility, credential, GCP/IAM, Kubernetes live state도 변경하지 않는다.
