# macOS generic agent relay 운영 계약

이 relay는 전용 macOS 사용자로 실행하는 Codex·Claude worker와 Kubernetes의
`seori-auth-agent-runtime` 사이에 둡니다. 모델 프로세스는 공개 JSON만 Unix socket에
보내고, root relay가 worker별 mTLS client certificate를 사용합니다. private key와
kubeconfig를 worker 사용자에게 주지 않습니다.

## 고정 경계

- Codex와 Claude는 서로 다른 비관리자 사용자·UID·GID·홈·workspace를 사용합니다.
- relay는 root로 실행하고 worker마다 별도 config, socket directory, mTLS certificate를
  사용합니다. 설치 시 socket 부모 디렉터리는 root 소유 `0700`으로 만듭니다. relay는
  재시작 때 남은 정상 runtime mode `0711`도 먼저 `0700`으로 좁힌 뒤 socket을 bind하고,
  socket을 해당 worker UID/GID 소유 `0600`으로 검증한 후 부모만 `0711`로 엽니다. 종료하면
  부모를 다시 `0700`으로 좁힙니다. 그 상위 경로도 root 소유이고 group/world write가 없어야
  합니다. socket path는 macOS `sun_path[104]` 경계와 schema/runtime parity를 위해 ASCII
  절대 경로 104바이트 이하로 제한합니다.
- relay는 native helper의 SHA-256을 시작 시 검증하고 macOS `getpeereid`와
  `LOCAL_PEERPID`로 accepted socket의 UID/GID/PID를 읽습니다. 요청 body의 principal은
  신뢰하지 않습니다.
- relay 설정은 Backoffice에서 승인된 `ConfigRevision`과 그 입력이 된
  `DiscoveryObservation`·`ProviderObservation`으로 생성한 투영본입니다. root 파일은 이
  투영본의 실행 캐시이며 별도 설정 원본이 아닙니다. relay는 전체 공개 binding의
  `projectionDigest`를 다시 계산하고, 시작 `READY` 레코드에 중앙 객체 ID·해시를 내보냅니다.
  Backoffice는 이 readback을 승인 투영본과 exact 비교해야 합니다.
- relay가 허용하는 목적지는 root config의 exact HTTPS origin과 `/v1/execute` 하나이며,
  TLS 1.3과 exact server name을 강제합니다. redirect와 임의 host/path는 없습니다. upstream
  요청은 응답 활동과 무관한 총 30초 deadline을 가지며, 만료하면 request와 response를 모두
  중단해 진행 슬롯을 반환합니다.
- 이 upstream은 `seorilabs-backoffice` 이미지의
  `scripts-dist/seori-auth-agent-runtime.cjs`를 실행하는 동명 Kubernetes Deployment입니다.
  이 패키지의 `runtime/entrypoint.mjs`가 만드는 `LocalAuthDaemon`과는 다른 프로세스이며,
  Backoffice runtime이 `/v1/execute`를 agent queue와 GitHub adapter 경로로 분기합니다.
- local 요청과 upstream 응답은 `CLAIM`, `HEARTBEAT`, `COMPLETE`, `FAIL`,
  `READBACK_REQUIRED`, `READBACK_RESOLVE`, `GITHUB_READY_PR`,
  `GITHUB_READY_PR_READBACK`별 닫힌 공개 스키마로 검증합니다. 각 object는 명시된 필드만
  허용하고 claim의 `taskInput`도 template별 고정 구조만 허용합니다. 따라서 이름을 미리
  열거하지 않은 credential 필드도 전달되지 않으며, `sessionId`만 공개 실행 핸들로
  사용할 수 있습니다. `CLAIM` 응답의 `agentKind`는 해당 relay의 `workerKind`와 정확히
  일치해야 합니다. 성공 envelope는 HTTP 2xx, 오류 envelope는 비2xx 상태에서만 전달하며,
  요청 stream이 중단돼도 relay가 만든 누적 Buffer는 반환 전에 지웁니다.
- relay가 비정상 종료해 socket이 남으면 자동 삭제하지 않습니다. inode와 프로세스 부재를
  확인한 운영자가 별도 복구 절차로 처리합니다.
- relay는 전체 Unix 연결을 4개, peer attestation부터 upstream 응답까지 진행 중인 요청을
  2개로 제한합니다. 세 번째 진행 요청은 body를 메모리에 담거나 peer를 조회하기 전에
  `503 agent_relay_busy`로 거부합니다.

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
  "schemaVersion": 2,
  "controlPlane": {
    "contractVersion": "agent-relay-projection/v1",
    "projectionId": "agent-relay:codex:example",
    "projectionDigest": "c7b8cf2e5228dc07890d661bdabfe5b94c3a1df798fb1e04f49cb55abf83cf2c",
    "configRevision": {
      "appId": "app-control-plane-example",
      "id": "config-revision-example",
      "revision": 1,
      "snapshotDigest": "1111111111111111111111111111111111111111111111111111111111111111"
    },
    "discoveryObservation": {
      "id": "discovery-observation-example",
      "sourceSha": "2222222222222222222222222222222222222222",
      "payloadHash": "3333333333333333333333333333333333333333333333333333333333333333"
    },
    "providerObservation": {
      "id": "provider-observation-example",
      "payloadHash": "4444444444444444444444444444444444444444444444444444444444444444"
    }
  },
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

위 중앙 객체 ID·해시, native helper SHA-256, UID/GID는 예시입니다. 예시
`projectionDigest`는 보이는 나머지 예시 필드에서 계산한 값입니다. 실제 설치에서는
native helper와 `dscl` readback을 각각 append-only `DiscoveryObservation`과
`ProviderObservation`에 기록하고, 사람이 활성화한 exact `ConfigRevision`에서 Backoffice가
이 JSON을 생성합니다. 운영자는 로컬에서 값을 조립하거나 수정하지 않습니다. config와
key는 root 소유로 두며 relay entrypoint는 root가 아니거나 config가 root 소유 regular
file이 아니거나 projection digest가 다르면 시작하지 않습니다. 이 digest는 승인본과 실행
캐시의 drift 검출값입니다. root 자체의 침해를 막는 서명으로 사용하지 않습니다.
`socketPath`는 빈 segment, `.`·`..`, trailing slash가 없는 canonical ASCII 절대 경로여야 하고
macOS `sockaddr_un.sun_path` 한계인 104바이트를 넘지 않습니다. UID/GID는 macOS
`UID_MAX`·`GID_MAX`인 2147483647 이하의 비-root 정수여야 합니다.
config, native helper, CA, certificate, private key 경로도 빈 segment, `.`·`..`, trailing
slash가 없는 canonical ASCII 절대 파일 경로만 허용합니다. 전체 경로는 NUL을 제외한
1,023바이트 이하이고 각 파일명 구간은 255바이트 이하여야 합니다.

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
   설치하고 `DiscoveryObservation`에 기록합니다.
2. 두 전용 사용자와 사용자별 agent login을 readback해 공개 UID/GID 상태를
   `ProviderObservation`에 기록합니다.
3. runtime을 `replicas: 0`으로 둔 채 server/client SAN, fingerprint, serial, Backoffice origin,
   GitHub App 공개 identity를 대조하고 같은 `ProviderObservation`에 기록합니다.
4. 관측값을 반영한 ConfigRevision을 검토·활성화하고 Backoffice가 worker별 projection을
   생성합니다.
5. root relay와 통신 경로를 설치하되 worker launchd job은 disabled로 둡니다. 시작 직후
   `READY.controlPlane`을 중앙 projection과 대조합니다.
6. fake private repository에서 cross-UID 거부, response loss, token revoke, restart,
   `CREATE_COMMIT/CREATE_REF/CREATE_PR` partial resume를 검증합니다.
7. 별도 검토 PR에서 runtime과 READY_PR gate를 열고, 일반 worker 각각 한 번의
   claim·heartbeat·완료와 Backoffice readback을 확인합니다.

이 문서는 사용자·인증서·launchd·Kubernetes 객체를 생성하거나 활성화하지 않습니다.
