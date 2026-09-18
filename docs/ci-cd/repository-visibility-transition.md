# 저장소 public 전환 지침

private 저장소를 public으로 바꿀 때 밟는 순서와, 실제로 밟아 본 함정을 남긴다.
`seorilabs/lucid-reversi` 전환(2026-09-18) 실측이 근거다.

핵심은 **public 전환이 깨뜨리는 것들이 대부분 조용하다**는 점이다. 빨간 X가 아니라
영구 pending, 빈 문자열, 상속 중단으로 나타나므로 전환 전에 목록으로 확인해야 한다.

## 1. 전환 전

### 1-1. 조직 시크릿 가시성 감사

```bash
gh api orgs/seorilabs/actions/secrets --jq '.secrets[] | "\(.visibility)\t\(.name)"' | sort
```

두 방향을 모두 본다.

| 가시성 | 전환 시 일어나는 일 | 대응 |
|---|---|---|
| `all` | **public이 된 저장소도 상속한다.** 클러스터·레지스트리 자격증명이 여기 있으면 노출면이 넓어진다 | 실사용처만 `selected`로 좁힌다 |
| `private` | **상속이 끊긴다.** 그 저장소가 쓰던 값이면 배포가 빈 값으로 fail-closed된다 | 해당 저장소가 자체 보유하도록 옮긴다 |

실사용처를 판정할 때 **repo 레벨 동명 시크릿이 org 값보다 우선**한다는 점을 쓴다.
자체 사본을 가진 저장소는 org 값이 필요 없으므로 `selected` 목록에서 뺄 수 있다.

```bash
gh secret list -R seorilabs/<repo>            # repo 레벨 보유분
gh search code --owner seorilabs "<SECRET_NAME>"   # 실사용처
```

> REST `PUT /orgs/{org}/actions/secrets/{name}`은 `encrypted_value`를 필수로 요구한다.
> 값을 모르면 API로 가시성만 바꿀 수 없다. GitHub UI(Settings → Secrets and variables →
> Actions → 해당 시크릿 → Repository access)에서는 값 재입력 없이 바뀐다.

`private` 쪽 대응은 **org 가시성을 넓히지 않는다.** `private`가 "조직 내 private 저장소
전체"라는 의도와 맞는 시크릿(마켓 서명 키 등)을 `selected`로 바꾸면 신규 저장소마다
수동 등록을 요구하게 되고, 빠뜨리면 조용히 깨진다. 대신 public이 된 저장소 하나가
**자체 사본**을 갖는다. 배치 우선순위는 Environment 시크릿 > repo 시크릿이다.
중앙 워크플로우 job이 `environment:`를 선언하면 **환경 시크릿이 caller가 넘긴 값을
덮어쓰므로**, `required_reviewers` 뒤에 둘 수 있다.

### 1-2. 포크 PR 승인 정책

```bash
gh api orgs/seorilabs/actions/permissions/fork-pr-contributor-approval --jq .approval_policy
gh api -X PUT orgs/seorilabs/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
```

기본값 `first_time_contributors`는 한 번 머지된 적 있는 외부 기여자를 승인 없이
통과시킨다. public 저장소에서는 `all_external_contributors`로 올린다.

### 1-3. 러너 라우팅 감사

public 저장소는 ARC에 **접근할 수 없다**. 조직 러너 그룹이 모두
`allows_public_repositories: false`이기 때문이다. job은 실패하지 않고 **영구 pending**
된다. 조용해서 가장 놓치기 쉽다.

```bash
gh api orgs/seorilabs/actions/runner-groups --jq '.runner_groups[] | "\(.name)\t\(.allows_public_repositories)"'
grep -n "uses:\|runs_on\|runs-on" .github/workflows/*.yml
```

중앙 재사용 워크플로우는 셋 중 하나다. **caller마다 어느 유형인지 확인한다.**

| 유형 | 예 | 대응 |
|---|---|---|
| `runs_on` 입력 노출 | `godot-checks`, `godot-pages`, `cleanup-actions-storage`, `godot-deploy-ait` | caller가 조건식을 **반드시 전달**. 기본값이 ARC라 생략하면 깨진다 |
| `ubuntu-latest` 하드코딩 | `godot-deploy-google-play` | 조치 불필요 |
| 중앙이 공개 여부로 결정 | `release-tag`, `init-release-version-ledger` | caller는 관여하지 않는다 |

caller가 전달하는 조건식:

```yaml
runs_on: ${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}
```

`contents: write` job은 caller에게 러너 선택권을 주지 않는다는 것이 계약이다
(`tests/release-version-authority.test.mjs`가 강제한다). 그런 job은 중앙이 스스로 정한다.

```yaml
runs-on: ${{ github.event.repository.visibility == 'public' && 'ubuntu-latest' || 'seorilabs-rpi-arm64' }}
```

> `private == false` 형태를 쓰지 않는다. GitHub 표현식의 느슨한 비교에서 `null`은 0으로
> 강제되어 `null == false`가 **참**이 되고, 페이로드가 비었을 때 public으로 새어나간다.
> `visibility == 'public'`은 `null == 'public'`이 거짓이라 기존 동작(ARC)으로 수렴한다.

### 1-4. 저장소 콘텐츠 감사

- **히스토리 시크릿 스캔**: 현재 tip이 아니라 전체 blob을 본다.
- **커밋 작성자 이메일**: public이 되면 영구 공개된다. 정리하려면 `main`만 rewrite해서는
  **무의미하다** — 릴리스 태그에서도 옛 커밋에 도달할 수 있다. 태그까지 rewrite하려면
  조직 `Immutable release tags` ruleset을 건드려야 하므로, 대개는 그대로 두는 편이 낫다.
- **로컬 절대경로**(`/Users/...`), ARC scale set 용량 수치 같은 내부 정보 제거.
- **라이선스**: `LICENSE`가 없으면 기본이 all rights reserved다. 상용 출시작은 코드와
  에셋을 분리한다 — `LICENSE`(MIT, 코드) + `LICENSE-ASSETS`(아트·오디오·브랜딩·스토어
  문구 독점) + `THIRD-PARTY-NOTICES.md`.
- **브랜치 보호**: `main`에 보호가 없으면 이때 건다.

## 2. 전환

저장소를 public으로 바꾼다.

## 3. 전환 직후

### 3-1. Environment 보호 규칙

**Team 플랜은 private 저장소에 `required_reviewers`를 걸 수 없다.** 시도하면 422
`Please ensure the billing plan supports the required reviewers protection rule`이 난다.
**public이 되면 열리므로 순서를 반대로 잡으면 안 된다.**

`deployment_branch_policy`는 private에서도 되지만, 같은 요청에 `reviewers` 키가 있으면
위 422가 난다. `reviewers` 키 자체를 빼고 보낸다. `wait_timer`는 integer라
`gh api -f`가 아니라 `--input <json>`으로 보낸다.

```bash
gh api -X PUT repos/seorilabs/<repo>/environments/<env> --input env.json
gh api -X POST repos/seorilabs/<repo>/environments/<env>/deployment-branch-policies \
  -f name=main -f type=branch
gh api -X POST repos/seorilabs/<repo>/environments/<env>/deployment-branch-policies \
  -f 'name=v*' -f type=tag
```

### 3-2. 마켓 시크릿 자체 보유

`private` 가시성이라 끊긴 값을 Environment 시크릿으로 채운다. 원본은
`~/.config/seorilabs`가 정본이고 절차는 `seorilabs-credentials` 스킬을 따른다.
값이 셸 인자·히스토리·로그에 남지 않도록 **stdin**으로 넘긴다.

```bash
base64 -i <file> | tr -d '\n' | gh secret set <NAME> --env <env> -R seorilabs/<repo>
```

### 3-3. GitHub Pages

private 저장소에서 Pages가 꺼져 있었다면 `Configure Pages` 단계에서 실패해 왔을 수 있다.
public 전환 후 활성화하면 정상화된다.

## 4. 검증

- 첫 실행의 job 라벨이 실제로 `ubuntu-latest`인지 본다.

```bash
gh api repos/seorilabs/<repo>/actions/runs/<id>/jobs \
  --jq '.jobs[] | "\(.name)\tlabels=\(.labels|join(","))\tgroup=\(.runner_group_name)"'
```

- 마켓 자격증명은 형태만 보지 말고 **실제로 호출해** 확인한다. App Store Connect는
  ASC API에 JWT로 `GET /v1/apps`를 던지면 3종(key id·issuer id·`.p8`)이 유효한 조합인지
  한 번에 확인된다.

## 5. 비용·정책 변화

public 저장소는 GitHub-hosted 표준 러너가 **무료·무제한**이다. macOS 러너도 포함된다
(`macos-latest`, `macos-14/15/26`, `macos-15-intel`, `macos-26-intel`, `xcode-27`).
larger runner는 public이어도 과금된다.

따라서 "Actions macOS 대신 Xcode Cloud" 정책의 **비용 근거는 public 저장소에서 사라진다.**
Xcode Cloud는 Apple Developer Program에 월 25 compute hours가 포함된 별도 과금이고
저장소 공개 여부와 무관하다. 서명·notarization 같은 다른 근거가 있으면 정책은 유지한다.

## 6. 함정 모음

| 증상 | 원인 |
|---|---|
| job이 실패도 성공도 아닌 채 멈춰 있다 | ARC 러너 대기. `runs_on` 미전달 또는 중앙 하드코딩 |
| 배포가 "secret is required"로 죽는다 | `private` 가시성 org 시크릿의 상속이 끊겼다 |
| `required_reviewers` 설정이 422 | Team 플랜 + private 저장소. public 전환 후에 건다 |
| `.p12` 암호가 맞는데 안 열린다 | OpenSSL 3.x가 RC2-40-CBC를 뺐다. `-legacy` 필요. CI의 `security import`는 영향 없음 |
| 이메일 rewrite했는데 여전히 보인다 | 릴리스 태그에서 옛 커밋에 도달한다 |
