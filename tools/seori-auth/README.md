# seori-auth

`seori-auth`는 자동화 worker가 비밀번호, TOTP seed, session cookie를 받지 않고
사전 승인된 capability만 5분 동안 한 번 사용하도록 제한하는 브로커입니다. 정책과
fd3 실행 코어에 더해, TCP listener가 없는 Unix domain socket 전용 로컬 HTTP
daemon과 append-only durable state를 제공합니다.

## 보안 경계

- `~/.config/seorilabs`는 canonical credential source of truth입니다.
- Secret Manager, Kubernetes Secret, browser profile은 실행 복제본입니다.
- 요청에는 `shared/...` 또는 `app/...` 형식의 logical credential reference만
  허용합니다.
- policy는 logical credential reference를 exact allowlist로 고정합니다.
- lease는 subject, run, repository, worker, commit SHA, provider, exact HTTPS origin,
  redirect chain, capability, resource, artifact SHA, adapter, credential/policy
  generation을 모두 고정합니다.
- lease TTL은 변경할 수 없는 5분이고 정상 실행 시도 전에 한 번 소비됩니다.
- HTTP에는 secret 조회, export, print endpoint가 없고 실행 결과에서도 child
  stdout/stderr를 반환하지 않습니다.
- browser checkout은 opaque capability ID와 provider/account/team/workspace/app의
  공개 identity만 반환합니다. profile, cookie, filesystem path는 상태와 응답에
  저장하지 않습니다.
- `CredentialCheckout`, `BrowserSessionBinding`, `ReauthRequest`, `AuthAuditEvent`는
  권한 `0600` append-only journal에 기록되고 재시작 시 replay됩니다.
- trusted adapter는 secret을 argv, 환경변수, stdin으로 받지 않고 전용 file
  descriptor 3으로만 받습니다.
- child stdout/stderr는 exact-match redaction에 의존하지 않고 broker 경계에서 전부
  폐기합니다. 출력 byte 상한과 exit status만 사용합니다.
- `authenticatePrincipal(socket)`이 증명한 subject/run/repository/worker와 HTTP claim이
  하나라도 다르면 정책 평가 전에 거부합니다. Authorization header나 body bearer는
  principal 증명으로 사용하지 않습니다.

## 임베딩과 로컬 daemon

```js
import {
  DurableAuthState,
  LocalAuthDaemon,
  SeoriAuthBroker,
} from '@seorilabs/seori-auth';

const broker = new SeoriAuthBroker({
  policy,
  adapters: [{
    id: 'provider-cli-v1',
    executable: '/opt/seori-auth/bin/provider-cli',
    providers: ['example-provider'],
    capabilities: ['bundle.upload.private'],
    credentialDelivery: 'fd3',
    buildArgs(binding) {
      return ['upload', '--artifact-sha256', binding.artifact.sha256];
    },
  }],
  async loadSecret({ credentialRef, credentialGeneration }) {
    // 이 trusted callback 안에서만 logical ID를 실행 복제본으로 해석합니다.
    // 반환값은 non-empty Buffer여야 하며 값이나 오류 원문을 기록하지 않습니다.
    return loadExecutionCopyAsBuffer(credentialRef, credentialGeneration);
  },
});

const lease = broker.issueLease(approvedRequest);
const result = await broker.execute({
  leaseId: lease.leaseId,
  context: approvedRequest,
  currentCredentialGeneration: approvedRequest.credentialGeneration,
});

const state = await DurableAuthState.open({
  directory: '/var/lib/seori-auth',
});
const daemon = new LocalAuthDaemon({
  socketPath: '/run/seori-auth/broker.sock',
  state,
  policy,
  adapters,
  loadSecret,
  getCredentialGeneration,
  readBrowserIdentity,
  authenticatePrincipal,
});
await daemon.start();
```

에이전트 입력으로 arbitrary executable, argument, environment를 받지 않습니다.
`buildArgs`는 검토된 adapter 코드이고 secret을 인자로 받지 않습니다. 실제 provider
adapter는 API 우선으로 구현하고, 웹 세션은 API가 없는 동작에만 사용합니다.

daemon은 절대 경로의 Unix socket만 받으며 socket과 state directory가 owner-only가
아니거나 symlink이면 시작을 거부합니다. 기존 path는 다른 broker의 socket인지
추측해 제거하지 않고 fail-closed합니다. TCP host/port 설정은 제공하지 않습니다.

## HTTP 계약

모든 요청은 `Content-Type: application/json`인 `POST`이며 query parameter를 받지
않습니다. 허용된 route는 다음 다섯 개뿐입니다.

| route | 역할 |
| --- | --- |
| `/auth/leases` | 정책·credential generation을 확인하고 `CredentialCheckout` 발급 |
| `/auth/leases/{id}/execute` | generation CAS와 run/repo/worker exact binding 뒤 1회 실행 |
| `/auth/browser-sessions/{id}/checkout` | 계정별 동시 1개인 opaque browser capability 발급 |
| `/auth/browser-sessions/{id}/complete` | 기대한 공개 identity와 provider readback이 모두 같을 때만 완료 |
| `/auth/reauth-requests` | 자동화 중단 사유를 `HUMAN_REAUTH_REQUIRED`로 기록 |

요청·응답과 네 가지 durable record의 JSON 계약은
[`schemas/local-broker.schema.json`](schemas/local-broker.schema.json)에 있습니다.
browser session은 신뢰 가능한 control plane이 daemon 시작 전 또는 같은 프로세스
안에서 `registerBrowserSession`으로 공개 binding만 등록합니다. 실제 profile과 cookie를
이 journal이나 HTTP 경계에 전달해서는 안 됩니다. `/complete`의 공개 identity는 HTTP
caller가 제출하지 않고 trusted `readBrowserIdentity` callback이 provider session에서
독립적으로 읽습니다.

## 배포 금지 gate

이 저장소의 Node.js 구현은 transport와 상태 전이를 검증하는 canary/reference
core입니다. macOS의 socket mode `0600`은 같은 UID로 실행되는 Codex, Claude, 다른
process를 구분하지 못하고, 같은 UID가 state directory에 접근할 수 있으면 journal을
읽거나 rewrite해 single-use와 audit 무결성을 훼손할 수 있습니다. Node 표준 API에는
이식 가능한 Unix peer credential 조회가 없습니다.

다음 gate를 모두 충족하기 전에는 로컬 host나 Kubernetes에 배포하면 안 됩니다.

- 별도 OS identity 아래 broker를 실행하고 worker가 socket 외 state directory에
  접근하지 못하게 할 것
- native peer credential과 scheduler가 agent 입력 밖에서 전달한 run capability 또는
  inherited FD를 함께 검증하는 production `authenticatePrincipal` adapter를 둘 것
- broker-held MAC/hash chain으로 journal startup integrity를 검증하거나 동등한
  append-only storage를 사용할 것
- native launcher, launchd 또는 container runtime에서 broker와 adapter child에
  `RLIMIT_CORE=0`과 non-dumpable 정책을 강제할 것
- opaque capability를 실제 격리 browser session에 연결하고 독립 identity readback을
  수행하는 Browser Vault provider adapter를 구현·검증할 것

`LocalAuthDaemon`은 attestor callback이 없으면 생성되지 않지만, callback 존재만으로
위 production gate 충족을 주장하지 않습니다. actual password/TOTP seed/session
cookie 저장, 실제 provider account 등록, 실제 cluster apply는 이 reference에 없습니다.

## 정책

[`policy/example.policy.json`](policy/example.policy.json)은 한 run, commit, artifact에
고정된 예시입니다. 실제 정책은 서명된 승인 또는 신뢰 가능한 control plane이
생성해야 합니다. `*`, 정규식, suffix domain match를 지원하지 않으며 HTTPS origin은
scheme, hostname, port가 모두 정확히 일치해야 합니다.

```sh
npm run lint
npm test
node src/cli.mjs validate-policy policy/example.policy.json
node src/cli.mjs classify-reauth trusted_device_required
```

## TOTP와 재인증

TOTP가 포함된 요청은 정책에 `allowTotp: true`가 있고 계정 종류가
`dedicated_bot`일 때만 허용됩니다. 이 저장소는 seed 저장, 코드 생성, SMS, push,
passkey, recovery code 자동화를 구현하지 않습니다. password와 TOTP seed를 같은
자동화 경계에 두면 MFA 분리가 약해지므로, 실제 signer는 별도 권한과 저장소를
사용해야 합니다.

`mfa_required`, `trusted_device_required`, `captcha_required`, `passkey_required`,
`sms_required`, `push_required`, `sso_required`, `account_recovery_required`,
`terms_acceptance_required`는 자동 retry하지 않고 사람의 trusted UI 재인증으로
전환합니다. 재인증 후에는 기존 lease나 browser capability를 재사용하지 않고 새
generation과 새 capability를 발급합니다.

## Kubernetes

[`k8s/local-sidecar-pod.yaml`](k8s/local-sidecar-pod.yaml)은 배포 불가 reference로,
worker와 broker가 같은
Pod에서 memory-backed socket volume만 공유하고 worker에는 broker state나 projected
service-account token을 mount하지 않는 예시입니다. broker state는 사전 준비된 PVC를
사용합니다. [`k8s/rbac.yaml`](k8s/rbac.yaml)은 이름이 고정된 실행 복제본 하나만
`get`하도록 제한합니다. Kubernetes RBAC은
명시적 deny가 아니라 권한의 합집합이므로, 다른 RoleBinding이나 ClusterRoleBinding이
worker에 Secret 권한을 주면 이 manifest가 그것을 취소하지 못합니다. 배포 전 반드시
전체 binding을 감사해야 합니다.

```sh
kubectl auth can-i get secrets \
  --as system:serviceaccount:seori-auth-workloads:seori-auth-worker \
  -n seori-auth-workloads
kubectl auth can-i list secrets \
  --as system:serviceaccount:seori-auth-workloads:seori-auth-local-pod \
  -n seori-auth-system
```

두 명령은 `no`여야 합니다. broker의 특정 Secret `get`만 별도로 `yes`여야 합니다.
manifest는 위 배포 금지 gate를 충족하지 않는 예제일 뿐이며 cluster에 적용하면 안
됩니다.
기본 NetworkPolicy는 모든 ingress/egress를 막습니다. 실제 provider와 Kubernetes API
egress는 배포 환경의 고정 destination을 확인한 뒤 별도 allowlist로 추가해야 합니다.

## 감사 이벤트

감사에는 record/generation, logical credential ID, subject, run, repository, worker,
공개 provider identity, capability와 outcome만 기록합니다. secret, Authorization
header, cookie, TOTP, child 출력은 journal이나 감사 callback에 전달하지 않습니다.
