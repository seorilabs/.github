# Fleet zero-touch repository bootstrap

## 현재 범위

`@seorilabs/repo-contract/bootstrap`은 GitHub App webhook에서 새 저장소를 안전하게 등록하기 위한 fail-closed 계획 코어다. 이 변경은 GitHub App 설치, custom property schema 생성, Environment 생성, PR 생성 또는 ruleset 활성화를 실행하지 않는다. 운영 adapter와 권한 부여 전까지는 배포할 수 없는 reference core다.

지원 이벤트는 `repository.created`, `repository.renamed`, `repository.archived`, `repository.unarchived`, 기본 브랜치 `push`다. 서명 검증 전에는 JSON을 파싱하거나 provider readback을 호출하지 않는다.

## 신뢰 경계

1. trusted loader가 `shared/github/fleet-app-webhook` logical credential을 Buffer로 대여한다.
2. HMAC SHA-256을 constant-time 비교하고 secret Buffer를 즉시 zeroize한다.
3. webhook의 숫자 organization·installation·repository ID와 `seorilabs` owner를 검증한다.
4. GitHub provider readback으로 repository ID, 현재 이름, visibility, archive, default branch와 exact HEAD SHA를 다시 확인한다.
5. delivery claim은 `CLAIMED`, 장애 후 `RESUME`, durable 저장 완료 뒤 `COMPLETED`만 허용한다.
6. Backoffice의 exact source SHA caller binding과 fleet-approved WorkflowBundle binding으로만 thin caller를 생성한다.
7. secret-free 계획 전체를 durable queue에 원자적으로 저장하고 동일 plan digest를 readback한 뒤 완료한다.

`completeDelivery`는 delivery 상태와 plan을 같은 트랜잭션에 기록해야 한다. 저장 실패 시 delivery를 완료 처리하면 안 되며, 재전달은 `RESUME`으로 같은 idempotent plan을 다시 만든다.

## 생성하는 작업

- Backoffice repository observation 또는 archive
- `fleet-managed`, `fleet-profile`, `fleet-state`, `fleet-ruleset=evaluate` custom property 정합화
- protected branch만 허용하는 `internal` Environment 정합화
- `.github/workflows/org-contract.yml` bootstrap PR 생성 또는 기존 PR 갱신

WorkflowBundle v4는 Android build-only caller와 Xcode Cloud run envelope의 중앙
generator/validator도 제공하지만, zero-touch bootstrap plan은 아직 static
`org-contract.yml`만 생성한다. non-promotable contract fixture probe와 실제 pilot의 두 번 연속 shadow parity,
WIF·Cloud Build IAM readback, Xcode Cloud workflow readback이 끝난 뒤 별도 wave에서 추가한다.
따라서 이 변경만으로 기존 release caller, secret visibility, ruleset 또는 provider 상태는
바뀌지 않는다.

작업별 idempotency key는 repository ID, operation kind와 canonical payload를 묶는다. 이미 열린 bootstrap PR은 갱신하며 새 PR을 만들지 않는다. 다른 자율 PR이 있으면 `WAITING_FOR_PR_SLOT`으로 중단해 repo당 동시 자율 PR 1개를 지킨다.

다음 조건은 추측하거나 우회하지 않는다.

- discovery 후보 0개 또는 여러 개
- ACTIVE config 부재
- 비어 있는 저장소
- 기본 브랜치가 `main`이 아님
- public repository의 별도 runner 정책 부재
- webhook·provider readback의 ID, 이름 또는 SHA 불일치

## 운영 adapter 권한

GitHub App installation token은 매 operation마다 숫자 repository ID 한 개와 필요한 permission만 지정해 발급한다. GitHub는 installation access token을 repository ID와 permission으로 더 좁힐 수 있다.

- repository readback: Metadata read, Contents read
- bootstrap PR: Contents write, Pull requests write
- repository custom property: Custom properties write
- Environment: Administration write

정적 caller는 secret을 받지 않으므로 조직 secret 가시성이나 WIF를 bootstrap 단계에서 추가하지 않는다. release workflow가 중앙 desired state에 활성화된 뒤 별도 승인된 adapter가 named secret visibility와 `job_workflow_ref`·숫자 repository ID 조건의 WIF를 구성한다. `secrets: inherit`는 허용하지 않는다.

공식 API 근거:

- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub App installation token scoping](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Repository custom properties](https://docs.github.com/en/rest/repos/custom-properties)
- [Deployment environments](https://docs.github.com/en/rest/deployments/environments)
- [OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)

## 운영 전 필수 gate

- GitHub App webhook secret을 Auth Broker trusted loader와 연결
- delivery claim·plan 저장을 Backoffice의 durable queue transaction과 연결
- GitHub readback·mutation adapter에 fixed API origin, redirect 거부, API version 고정
- mutation 직전 repository ID·source SHA·open PR count 재검증
- custom property schema와 Evaluate ruleset을 조직에서 별도 승인 후 생성
- private RN/Godot canary에서 5분 등록, 10분 bootstrap PR 또는 정확한 `needs_input` 검증
- Android build caller를 `.github/workflows/android-build-only.yml@refs/heads/main`에만 두고 runtime ref 검증과 ruleset 보호 확인
- ARC live Pod imageID와 signed WorkflowBundle runner digest 일치 확인
- 두 번의 shadow parity 전에는 ruleset Active 전환 금지
