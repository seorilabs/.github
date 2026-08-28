# seori-auth

`seori-auth`는 자동화 worker가 비밀번호, TOTP seed, session cookie를 받지 않고
사전 승인된 capability만 5분 동안 한 번 사용하도록 제한하는 브로커입니다. 정책과
fd3 실행 코어에 더해 로컬 Unix domain socket daemon, Kubernetes용 TLS 1.3 mTLS
daemon, MAC-chain durable state, native OS 경계, encrypted Browser Vault를 제공합니다.

## 보안 경계

- `~/.config/seorilabs`는 canonical credential source of truth입니다.
- Secret Manager, Kubernetes Secret, browser profile은 실행 복제본입니다.
- 요청에는 `shared/...` 또는 `app/...` 형식의 logical credential reference만
  허용합니다.
- policy는 logical credential reference를 exact allowlist로 고정합니다.
- lease는 subject, run, repository, worker, commit SHA, provider, exact HTTPS origin,
  redirect chain, capability, resource, artifact SHA, adapter, credential/policy
  generation, canonical account ID, approval ID/mode/expiry/max-use를 모두 고정합니다.
  `authFactors`도 policy의 순서가 있는 exact strategy 하나와 같아야 합니다.
- lease TTL은 변경할 수 없는 5분이고 정상 실행 시도 전에 한 번 소비됩니다. approval ID는
  첫 발급 journal mutation에서 원자적으로 예약되며 같은 idempotency key의 exact replay만
  같은 checkout을 반환합니다.
- HTTP에는 secret 조회, export, print endpoint가 없고 실행 결과에서도 child
  stdout/stderr를 반환하지 않습니다.
- browser checkout은 opaque capability ID와 provider/account/team/workspace/app의
  공개 identity만 반환합니다. profile, cookie, filesystem path는 상태와 응답에
  저장하지 않습니다. `EncryptedBrowserVault`만 암호화 원본과 tmpfs clone 경로를
  알고 provider/account/role별 profile과 account별 동시 실행 1개를 강제합니다.
  checkout은 expected profile generation, source SHA, subject/run/repo/worker에도 묶입니다.
  checkout에 사용한 credential lease와 그 lease의 origin/action/resource/artifact/approval
  전체를 durable authorization으로 고정하고 trusted browser adapter 실행 전에 다시
  exact-match합니다. 외부 동작 전 `CHECKED_OUT -> CLAIMED` generation CAS를 먼저 fsync하며,
  crash 또는 불명 결과 뒤에는 provider readback으로만 `COMPLETED`/`AVAILABLE`을 결정하고
  adapter를 재실행하지 않습니다.
- `CredentialCheckout`, `BrowserSessionBinding`, `ReauthRequest`, `ProviderGrant`, `AuthAuditEvent`는
  권한 `0600` append-only journal에 기록되고 재시작 시 replay됩니다. 운영 모드의
  schema v2 record는 broker-held 32-byte key의 HMAC-SHA256 chain으로 인증하며,
  외부에 보관한 head MAC을 함께 주면 tail rollback도 탐지합니다.
- Backoffice의 provider 실행은 일반 `/auth/*` surface를 늘리지 않습니다. exact Backoffice
  SPIFFE mTLS peer와 Ed25519 run attestation을 모두 통과한 내부 경계에서만 5분·1회용
  `ProviderGrant`를 등록합니다. grant는 run/repo/source/provider/resource/action/environment,
  artifact, logical credential generation/public identity, policy generation, approval과
  `bindingHash` 전체에 고정됩니다.
- trusted adapter는 secret을 argv, 환경변수, stdin으로 받지 않고 전용 file
  descriptor 3으로만 받습니다.
- child stdout/stderr는 exact-match redaction에 의존하지 않고 broker 경계에서 전부
  폐기합니다. 출력 byte 상한과 exit status만 사용합니다.
- `authenticatePrincipal(socket, metadata)`가 증명한 subject/run/repository/worker와 HTTP claim이
  하나라도 다르면 정책 평가 전에 거부합니다. Authorization header나 body bearer는
  principal 증명으로 사용하지 않습니다.
- 로컬은 Linux의 `SO_PEERCRED`, macOS의 `getpeereid`와 `LOCAL_PEERPID`를 사용하는 native
  attestor가 UID/GID/PID를 읽습니다. 같은 helper의 launcher는 adapter 실행 전에
  `RLIMIT_CORE=0`, non-dumpable/debugger 차단, no-new-privileges를 설정합니다.
- Kubernetes는 검증된 client certificate의 exact SPIFFE URI SAN과 scheduler가 Ed25519로
  서명한 5분 이하·1회용 run attestation을 함께 요구합니다. body와 bearer token은
  principal 근거로 사용하지 않습니다.
- `BrowserLoginBoundary`는 exact origin, redirect chain, 공개 identity, provider-only
  network allowlist를 비밀번호/TOTP 주입 전후에 다시 확인합니다. screenshot, video,
  trace, HAR, clipboard, download, extension, storage-state export가 모두 꺼져 있지 않으면
  factor loader를 호출하지 않습니다.
- account 종류는 요청이 아니라 signed policy의 canonical account registry에서만 읽습니다.
  `human` account의 password 또는 TOTP는 browser control 검사와 factor loader보다 먼저
  `HUMAN_REAUTH_REQUIRED`로 중단합니다. 감지된 interactive gate는 durable `ReauthRequest`로
  연결되어 trusted UI가 exact binding으로 resolve할 때까지 새 checkout도 차단합니다.

## 임베딩과 로컬 daemon

```js
import {
  BrowserLoginBoundary,
  DurableAuthState,
  EncryptedBrowserVault,
  LocalAuthDaemon,
  NativeSecurityBoundary,
  SeoriAuthBroker,
} from '@seorilabs/seori-auth';

const nativeBoundary = await NativeSecurityBoundary.open({
  helperPath: '/opt/seori-auth/bin/seori-auth-native',
  expectedSha256: approvedNativeHelperSha256,
  resolvePrincipal: resolveSchedulerRunFromPeer,
});
const broker = new SeoriAuthBroker({
  policy,
  adapters: [{
    id: 'provider-cli-v1',
    executable: '/opt/seori-auth/bin/provider-cli',
    providers: ['example-provider'],
    capabilities: ['bundle.upload.private'],
    credentialDelivery: 'fd3',
    launcher: nativeBoundary.launcher(),
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

const lease = broker.issueLease(approvedRequest, { idempotencyKey: approvedOccurrenceId });
const result = await broker.execute({
  leaseId: lease.leaseId,
  context: approvedRequest,
  currentCredentialGeneration: approvedRequest.credentialGeneration,
});

const state = await DurableAuthState.open({
  directory: '/var/lib/seori-auth',
  writerLockProvider: nativeBoundary.lockProvider(),
  journalMacKey,
  requireIntegrity: true,
  expectedJournalHeadMac,
});
const daemon = new LocalAuthDaemon({
  socketPath: '/run/seori-auth/broker.sock',
  state,
  policy,
  adapters,
  loadSecret,
  getCredentialGeneration,
  readBrowserIdentity,
  authenticatePrincipal: (socket) => nativeBoundary.authenticatePrincipal(socket),
  browserVault,
  browserAdapter: nativeBoundary.browserAdapter({
    execute: ({ cloneDirectory, authorization, signal }) =>
      trustedProviderBrowserAdapter.execute({ cloneDirectory, authorization, signal }),
    terminate: ({ capabilityId, reason }) =>
      trustedProviderBrowserAdapter.killAndWait({ capabilityId, reason }),
  }),
  reconcileBrowserSession: ({ authorization }) =>
    trustedProviderApi.readActionOutcome({ authorization }),
});
await daemon.start();
```

에이전트 입력으로 arbitrary executable, argument, environment를 받지 않습니다.
`buildArgs`는 검토된 adapter 코드이고 secret을 인자로 받지 않습니다. 실제 provider
adapter는 API 우선으로 구현하고, 웹 세션은 API가 없는 동작에만 사용합니다.

`authStrategies`의 배열 순서는 fallback 순서입니다. 첫 전략 이외의 checkout은 같은
run·repo·SHA·action·resource에 대해 모든 앞선 전략이 실제로 실패했다는 durable
non-secret audit evidence가 있어야 합니다. `SeoriAuthBroker`의 메모리 lease 경로는 이
증거를 제공할 수 없으므로 첫 전략만 허용합니다. policy의 `actionClass`는 capability
문자열과 별도로 서명되며 protected class 또는 `resource.environment=production`은
항상 `per_run` approval을 요구합니다.

daemon은 절대 경로의 Unix socket만 받으며 socket과 state directory가 owner-only가
아니거나 symlink이면 시작을 거부합니다. 기존 path는 다른 broker의 socket인지
추측해 제거하지 않고 fail-closed합니다. TCP host/port 설정은 제공하지 않습니다.
durable journal은 native advisory writer lock을 배포 생명주기 전체에 보유하므로 같은
경로를 두 broker instance가 동시에 replay/append할 수 없습니다. crash 뒤 남은 private
lock file은 소유권이 아니며 OS lock을 새로 획득한 instance만 replay합니다.

browser adapter는 `NativeSecurityBoundary.browserAdapter`가 만든 AbortSignal·terminate
계약만 허용합니다. timeout이면 abort 뒤 native kill과 adapter promise의 완전 종료를
모두 확인하기 전에는 clone을 폐기하거나 session을 recovery/reuse 상태로 바꾸지 않습니다.

## HTTP 계약

모든 요청은 `Content-Type: application/json`인 `POST`이며 query parameter를 받지
않습니다. 허용된 route는 다음 다섯 개뿐입니다.

| route | 역할 |
| --- | --- |
| `/auth/leases` | 정책·credential generation을 확인하고 idempotency key별 `CredentialCheckout`과 approval 1회를 원자적으로 예약 |
| `/auth/leases/{id}/execute` | generation CAS와 run/repo/worker exact binding 뒤 1회 실행 |
| `/auth/browser-sessions/{id}/checkout` | 정책 승인된 1회 lease와 exact 실행 문맥을 소비해 계정별 동시 1개인 opaque browser capability 발급 |
| `/auth/browser-sessions/{id}/complete` | durable `CLAIMED` CAS 뒤 trusted adapter를 한 번만 실행하고, crash retry는 provider readback만으로 종결 |
| `/auth/reauth-requests` | 자동화 중단 사유를 `HUMAN_REAUTH_REQUIRED`로 기록 |

공개 auth 요청·응답과 기존 durable record의 JSON 계약은
[`schemas/local-broker.schema.json`](schemas/local-broker.schema.json)에 있습니다.
browser session은 신뢰 가능한 control plane이 daemon 시작 전 또는 같은 프로세스
안에서 `registerBrowserSession`으로 공개 binding만 등록합니다. 실제 profile과 cookie를
이 journal이나 HTTP 경계에 전달해서는 안 됩니다. `/complete`의 공개 identity는 HTTP
caller가 제출하지 않고 trusted `readBrowserIdentity` callback이 provider session에서
독립적으로 읽습니다.

### Backoffice 전용 provider control-plane

다음 경로는 공개 auth API가 아닙니다. broker runtime에 고정된 단 하나의
`providerControlPlane.backofficeClientSpiffeId`와
`/internal/control-plane/provider-grants` scope에서만 열립니다. 모든 요청은 같은
run/repo/worker를 증명하는 1회용 Ed25519 attestation을 추가로 요구합니다.

| route | exact body | 응답 |
| --- | --- | --- |
| `/internal/control-plane/provider-grants` | `idempotencyKey`, `workerId`, `grant`, `digest` | `201 { policyGrant }` |
| `/internal/control-plane/provider-grants/{id}/verify` | `workerId`, `expectedDigest`, `expectedBindingHash`, `expectedCommandDigest`, `expectedPolicyGeneration` | `200 { policyGrant }` |
| `/internal/control-plane/provider-grants/{id}/consume` | verify body + `expectedExecutionGeneration`, `idempotencyKey` | `200 { policyGrant, execution }` |
| `/internal/control-plane/provider-grants/{id}/result` | verify body + `expectedExecutionGeneration` | `200 { policyGrant, execution }` |
| `/internal/control-plane/provider-grants/{id}/observation` | verify body + `expectedExecutionGeneration` | `200 { policyGrant, observation }` 또는 관측 전 `204` |

`policyGrant`는 `{id,digest,bindingHash,commandDigest,policyGeneration,state:"ACTIVE"}`만
반환합니다. `execution`은 `{generation,outcome,errorCode?}`이고 outcome은 `SUCCESS`,
`ADAPTER_FAILED`, `HUMAN_REAUTH_REQUIRED`, `RESULT_UNKNOWN` 중 하나입니다. 오류는 기존과
같이 `{error:{code}}`만 반환하며 protected action의 미승인은 정확히
`per_run_approval_required`, 사람 재인증은 정확히 `HUMAN_REAUTH_REQUIRED`입니다.

등록된 `bindingHash`는 secret 없는 strict command envelope 하나로만 해석됩니다. 실행 전에
grant를 durable `CONSUMED`로 CAS하고, root-owned runtime config에 미리 등록된 native adapter
하나만 선택합니다. credential은 기존 checkout/Secret Manager 경계에서 fd3으로, canonical
public command는 fd4로, strict public result는 fd5로 전달합니다. adapter 결과가 불명확하면
`RESULT_UNKNOWN`을 기록하고 같은 grant로 재실행하지 않습니다. 별도 readback identity와 새
`READBACK_FIRST` grant를 발급한 뒤 observation으로만 상태를 확정합니다.

## 운영 활성화 gate

native attestor/launcher, HMAC journal, encrypted filesystem Browser Vault, 분리된
password/TOTP service, mTLS runtime과 Kubernetes renderer는 구현되어 deterministic
fake-account canary로 검증됩니다. 그러나 이 package만으로 실제 provider나 cluster가
자동 활성화되지는 않습니다. 다음 외부 binding을 모두 검증하기 전에는 production
credential을 연결하거나 manifest를 apply하지 않습니다.

- broker 전용 OS/container identity와 worker가 읽을 수 없는 state/Vault mount
- scheduler가 peer UID/GID/PID를 승인된 run/repo/SHA principal로 바꾸는 resolver
- broker process 자체와 adapter를 native helper로 시작하는 immutable image/launchd unit
- Kubernetes mTLS client/server CA, exact SPIFFE identity와 scheduler run-attestation signing key
- journal MAC key, 외부 head checkpoint, Vault key의 Secret Manager logical binding
- provider별 정확한 origin/redirect/public account identity와 egress-proxy allowlist
- password loader와 TOTP signer의 서로 다른 workload identity 및 secret 단위 IAM
- 암호화 PVC, tmpfs clone, mTLS identity, 실제 image digest가 고정된 K8s render

[`docs/production-runbook.md`](docs/production-runbook.md)가 활성화·rollback 절차와
fail-closed 검증 명령을 정의합니다. 운영 manifest는 public deployment config에서
[`scripts/render-production-k8s.mjs`](scripts/render-production-k8s.mjs)가 한 번에 생성하며
기존 static production 경로는 comment-only compatibility marker입니다. 이번 구현과 테스트는
실제 password/TOTP seed/session cookie, provider account 생성, cluster 변경을 수행하지
않습니다.

## 정책

[`policy/example.policy.json`](policy/example.policy.json)은 한 run, commit, artifact에
고정된 예시입니다. 실제 정책은 서명된 승인 또는 신뢰 가능한 control plane이
생성해야 합니다. `*`, 정규식, suffix domain match를 지원하지 않으며 HTTPS origin은
scheme, hostname, port가 모두 정확히 일치해야 합니다. 공개/production 변경, 심사
제출·취소, tester/role/permission과 key/certificate 변경은 policy가 허용해도 반드시
`per_run` approval이어야 합니다.

```sh
npm run lint
npm test
./.build/seori-auth-native self-test
node src/cli.mjs validate-policy policy/example.policy.json
node src/cli.mjs classify-reauth trusted_device_required
```

## TOTP와 재인증

password 또는 TOTP가 포함된 요청은 canonical account 종류가 `dedicated_bot`일 때만
허용되며, TOTP는 추가로 정책의 `allowTotp: true`가 필요합니다. account 종류를 request로
제출하는 계약은 없습니다. `BrowserLoginBoundary`는 서로 다른 객체 identity의
password loader와 TOTP signer를 요구하고, logical credential ID도 서로 달라야 합니다.
signer는 seed를 반환하지 않고 origin/account가 확인된 뒤 30초 이내 만료하는 6자리
또는 8자리 코드 Buffer만 내놓으며 주입 직후 zeroize합니다. 실제 seed 저장과 OTP
계산은 별도 workload identity를 가진 signer service가 담당해야 하며 이 저장소에는
seed getter/exporter가 없습니다.

`SecretManagerPasswordLoader`는 trusted catalog가 지정한 logical ID/generation을 숫자로
고정된 Secret Manager version 하나에만 연결합니다. `MacOSKeychainPasswordLoader`는
catalog가 지정한 public Keychain service/account만 trusted reader에 전달합니다.
`RemoteTotpSignerClient`는 seed를 읽는 API 없이 logical TOTP ID, generation, provider,
account, exact origin을 별도 signer service에 고정합니다. 세 객체 모두 임의 resource
name이나 locator를 agent 요청에서 받지 않습니다.

`mfa_required`, `trusted_device_required`, `captcha_required`, `passkey_required`,
`sms_required`, `push_required`, `sso_required`, `account_recovery_required`,
`terms_acceptance_required`는 자동 retry하지 않고 사람의 trusted UI 재인증으로
전환합니다. 재인증 후에는 기존 lease나 browser capability를 재사용하지 않고 새
generation과 새 capability를 발급합니다.

## Kubernetes

[`k8s/local-sidecar-pod.yaml`](k8s/local-sidecar-pod.yaml), `rbac.yaml`,
`network-policy.yaml`은 초기 계약의 회귀 테스트를 위해 남긴 **배포 불가 legacy
reference**입니다. 실제 배포 후보는 `k8s/production`뿐이며 broker도 Kubernetes Secret을
읽지 않고 별도 workload identity로 Secret Manager API를 사용합니다. Kubernetes RBAC은
명시적 deny가 아니라 권한의 합집합이므로 배포 전 전체 RoleBinding과
ClusterRoleBinding을 감사해야 합니다.

```sh
for sa in auth-broker password-loader totp-signer; do
  kubectl auth can-i get secrets \
    --as "system:serviceaccount:auth-broker:${sa}" -n auth-broker
  kubectl auth can-i list secrets \
    --as "system:serviceaccount:auth-broker:${sa}" -n auth-broker
done
```

여섯 결과는 모두 `no`여야 합니다. legacy reference는 cluster에 적용하면 안 됩니다.

[`k8s/production/README.md`](k8s/production/README.md)의 절차는 `auth-broker` namespace,
restricted Pod Security, Kubernetes API 권한이 비어 있는 세 ServiceAccount, default-deny
NetworkPolicy, mTLS egress proxy 전용 경로, read-only root filesystem,
`seccompProfile: RuntimeDefault`, `drop: ["ALL"]`, native launcher, encrypted PVC와 tmpfs
clone mount를 하나의 JSON `List`로 render합니다. NetworkPolicy는 FQDN을 검증하지 못하므로
provider hostname과 TLS identity는 egress proxy가 exact allowlist로 검증해야 합니다.

projected ServiceAccount token은 `/var/run/seori-auth/projected-identity/token` 하나만
허용합니다. native helper가 read-only mount root를 연 뒤 Linux `openat2`의
`RESOLVE_BENEATH`, `RESOLVE_NO_MAGICLINKS`, `RESOLVE_NO_XDEV`로 Kubernetes atomic symlink를
안전하게 따라가 FD4에 한 번만 전달합니다. 고정 digest가 검증된 Secret Manager child는
FD4를 한 번 읽은 직후 닫으며 token을 stdout, argv, env, 일반 파일로 relay하지 않습니다.
factor 서비스는 resource name을 선택하지 못하고 logical credential ID와 generation만
요청합니다. 시작 시 factor binding과 workload의 credential binding이 정확히 같은 partition인지
검증하고, 렌더된 public GSA/WIF audience/config digest와 실제 `secret-access.json`이 다르면
readiness를 만들기 전에 중단합니다.

## 감사 이벤트

감사에는 record/generation, logical credential ID, subject, run, repository, worker,
공개 provider identity, capability와 outcome만 기록합니다. secret, Authorization
header, cookie, TOTP, child 출력은 journal이나 감사 callback에 전달하지 않습니다.
