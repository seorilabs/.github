# seori-auth

`seori-auth`는 자동화 worker가 비밀번호나 토큰 값을 받지 않고, 사전 승인된
capability만 5분 동안 한 번 실행하도록 제한하는 브로커 코어입니다. 이 패키지는
네트워크 daemon이 아니라 임베딩 가능한 Node.js 라이브러리와 정책 검증 CLI를
제공합니다.

## 보안 경계

- `~/.config/seorilabs`는 canonical credential source of truth입니다.
- Secret Manager, Kubernetes Secret, browser profile은 실행 복제본입니다.
- 요청에는 `shared/...` 또는 `app/...` 형식의 logical credential reference만
  허용합니다.
- lease는 subject, run, repository, commit SHA, provider, exact HTTPS origin,
  redirect chain, capability, resource, artifact SHA, adapter, credential/policy
  generation을 모두 고정합니다.
- lease TTL은 변경할 수 없는 5분이고 정상 실행 시도 전에 한 번 소비됩니다.
- 라이브러리에 secret 조회 또는 export 메서드와 HTTP endpoint가 없습니다.
- trusted adapter는 secret을 argv, 환경변수, stdin으로 받지 않고 전용 file
  descriptor 3으로만 받습니다.
- child stdout/stderr redaction은 방어 계층일 뿐입니다. secret을 인코딩하거나
  변형해서 출력할 수 있는 실행 파일은 trusted adapter로 등록하면 안 됩니다.

## 사용 예

```js
import { SeoriAuthBroker } from '@seorilabs/seori-auth';

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
```

에이전트 입력으로 arbitrary executable, argument, environment를 받지 않습니다.
`buildArgs`는 검토된 adapter 코드이고 secret을 인자로 받지 않습니다. 실제 provider
adapter는 API 우선으로 구현하고, 웹 세션은 API가 없는 동작에만 사용합니다.

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
`sso_required`, `account_recovery_required`는 자동 retry하지 않고 사람의 trusted UI
재인증으로 전환합니다. 재인증 후에는 기존 lease를 재사용하지 않고 새 generation과
새 lease를 발급합니다.

## Kubernetes

[`k8s/rbac.yaml`](k8s/rbac.yaml)은 worker에 Secret 권한을 부여하지 않고 broker도
이름이 고정된 실행 복제본 하나만 `get`할 수 있는 최소 예시입니다. Kubernetes RBAC은
명시적 deny가 아니라 권한의 합집합이므로, 다른 RoleBinding이나 ClusterRoleBinding이
worker에 Secret 권한을 주면 이 manifest가 그것을 취소하지 못합니다. 배포 전 반드시
전체 binding을 감사해야 합니다.

```sh
kubectl auth can-i get secrets \
  --as system:serviceaccount:seori-auth-workloads:seori-auth-worker \
  -n seori-auth-workloads
kubectl auth can-i list secrets \
  --as system:serviceaccount:seori-auth-system:seori-auth-broker \
  -n seori-auth-system
```

두 명령은 `no`여야 합니다. broker의 특정 Secret `get`만 별도로 `yes`여야 합니다.
manifest는 예제일 뿐이며 이 변경에서 cluster에 적용하지 않습니다.

## 감사 이벤트

실행 감사에는 lease/rule ID, logical credential ID, subject, run, repository, SHA,
provider, capability, resource, artifact SHA, adapter, outcome만 전달합니다. secret,
Authorization header, cookie, TOTP, child 출력은 감사 callback에 전달하지 않습니다.
