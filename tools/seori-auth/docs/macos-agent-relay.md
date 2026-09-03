# macOS generic agent relay 운영 계약

이 relay는 전용 macOS 사용자로 실행하는 Codex·Claude worker와 Kubernetes의
`seori-auth-agent-runtime` 사이에 둡니다. 모델 프로세스는 공개 JSON만 Unix socket에
보내고, root relay가 worker별 mTLS client certificate를 사용합니다. private key와
kubeconfig를 worker 사용자에게 주지 않습니다.

## 고정 경계

- Codex와 Claude는 서로 다른 비관리자 사용자·UID·GID·홈·workspace를 사용합니다.
- relay는 root로 실행하고 worker마다 별도 config, socket directory, mTLS certificate를
  사용합니다. socket은 해당 worker UID/GID 소유 `0600`, 부모 디렉터리는 root 소유
  `0711`입니다.
- relay는 native helper의 SHA-256을 시작 시 검증하고 macOS `getpeereid`와
  `LOCAL_PEERPID`로 accepted socket의 UID/GID/PID를 읽습니다. 요청 body의 principal은
  신뢰하지 않습니다.
- relay가 허용하는 목적지는 root config의 exact HTTPS origin과 `/v1/execute` 하나이며,
  TLS 1.3과 exact server name을 강제합니다. redirect와 임의 host/path는 없습니다.
- local 요청·upstream 응답에서 password, TOTP, cookie, API key, bearer, certificate,
  private key, lease/grant/action token 형태의 필드를 거부합니다. `sessionId`만 공개 실행
  핸들로 사용할 수 있습니다.
- relay가 비정상 종료해 socket이 남으면 자동 삭제하지 않습니다. inode와 프로세스 부재를
  확인한 운영자가 별도 복구 절차로 처리합니다.

## 설치 전에 필요한 사람 결정

1. `seori-codex`, `seori-claude` 전용 사용자 생성을 승인하고 numeric UID/GID를 확정합니다.
2. 각 사용자에서 기존 구독 계정으로 한 번 로그인할지, API model worker로 바꿀지 정합니다.
   기존 사용자의 `~/.codex`, `~/.claude`, Keychain 파일은 복사하지 않습니다. Codex CLI는
   `codex login --device-auth`, Claude Code는 사용자별 `claude install`과
   `claude auth login`을 지원합니다.
3. worker별 `/instance/{unique-id}` SPIFFE SAN의 client certificate와 root 전용 실행 복제본,
   그리고 Kubernetes runtime까지의 고정 통신 경로를 승인합니다. 현재
   `seori-auth-agent-runtime` Service는 cluster 내부 전용이므로, root 전용 최소 kubeconfig의
   고정 local tunnel 또는 별도 mTLS passthrough endpoint가 먼저 필요합니다.
4. 기존 Codex 자동화는 새 worker와 동시에 실행하지 않도록 exact ID를 읽고 이관합니다.
   Claude generic worker는 조직당 하나만 만듭니다.

## 코드와 설정

- relay server: `src/agent-relay.mjs`
- root entrypoint: `runtime/agent-relay-entrypoint.mjs`
- worker 공개 client: `runtime/agent-relay-client.mjs`
- config schema: `schemas/agent-relay-config.schema.json`

root config에는 인증 값이 아니라 경로와 공개 binding만 기록합니다.

```json
{
  "schemaVersion": 1,
  "workerKind": "CODEX",
  "socketPath": "/private/var/run/seori-auth-agent/codex/relay.sock",
  "expectedPeer": { "uid": 5010, "gid": 5010 },
  "nativeHelper": {
    "path": "/opt/seori-auth/bin/seori-auth-native",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "upstream": {
    "origin": "https://127.0.0.1:19443",
    "serverName": "seori-auth-agent-runtime.auth-broker.svc.cluster.local",
    "tls": {
      "caPath": "/private/etc/seori-auth-agent/codex/ca.pem",
      "certificatePath": "/private/etc/seori-auth-agent/codex/tls.crt",
      "privateKeyPath": "/private/etc/seori-auth-agent/codex/tls.key"
    }
  }
}
```

위 SHA-256과 UID/GID는 예시 자리표시자입니다. 실제 설치에서는 exact build readback과
`dscl` 결과로 render하고, config와 key는 root 소유로 둡니다. relay entrypoint는 root가
아니거나 config가 root 소유 regular file이 아니면 시작하지 않습니다.

worker는 요청을 stdin으로만 보냅니다.

```sh
node /opt/seori-auth/runtime/agent-relay-client.mjs \
  --socket=/private/var/run/seori-auth-agent/codex/relay.sock
```

argv·환경변수·로그에는 요청 body나 인증 값을 넣지 않습니다. worker launchd job은 Codex
`workspace-write`, Claude의 명시적 allowed-tools/permission 정책과 전용 workspace를 사용하고,
인증 홈과 `/etc/seori-auth-agent`를 작업 디렉터리에 포함하지 않습니다.

## 활성화 순서

1. exact source에서 native helper를 빌드하고 checksum을 읽은 뒤 root-owned immutable 경로에
   설치합니다.
2. 두 전용 사용자와 사용자별 agent login을 readback합니다.
3. runtime을 `replicas: 0`으로 둔 채 server/client SAN, fingerprint, serial, Backoffice origin,
   GitHub App 공개 identity를 대조합니다.
4. root relay와 통신 경로를 설치하되 worker launchd job은 disabled로 둡니다.
5. fake private repository에서 cross-UID 거부, response loss, token revoke, restart,
   `CREATE_COMMIT/CREATE_REF/CREATE_PR` partial resume를 검증합니다.
6. 별도 검토 PR에서 runtime과 READY_PR gate를 열고, 일반 worker 각각 한 번의
   claim·heartbeat·완료와 Backoffice readback을 확인합니다.

이 문서는 사용자·인증서·launchd·Kubernetes 객체를 생성하거나 활성화하지 않습니다.
