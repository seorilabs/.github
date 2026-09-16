# 릴리스 ref 보호

원장 브랜치와 릴리스 태그는 force-push, 삭제, 이동이 불가능해야 한다. 그래야 "GitHub만으로 출처를
재현한다"는 전제가 성립한다. desired state는
[`contracts/release-ref-protection.ledger-branch.json`](../../contracts/release-ref-protection.ledger-branch.json)과
[`contracts/release-ref-protection.release-tags.json`](../../contracts/release-ref-protection.release-tags.json)이다.

## 적용 주체

organization ruleset 변경은
[`contracts/provider-auth-matrix.yaml`](../../contracts/provider-auth-matrix.yaml)이 `humanOnlyActions`로
고정한 **사람 전용** 행위다. 에이전트는 desired state와 readback까지만 담당한다.

| 에이전트 | 사람 |
|---|---|
| desired state JSON 유지 | 아래 `gh api` 명령 실행 |
| `readback-release-ref-protection.mjs`로 GET 관측 | `evaluate` → `active` 승격 |
| 증거 JSON을 `docs/migration/evidence/`에 남김 | 기존 중복 ruleset 정리 판단 |

## 규칙 구성

| 대상 | 포함 | 의도적으로 뺀 규칙 |
|---|---|---|
| `refs/heads/release-version-ledger` | `deletion`, `non_fast_forward`, `required_linear_history` | `update`, `creation`, `pull_request`, `required_signatures`, `required_status_checks` |
| `refs/tags/v*` | `deletion`, `update`, `non_fast_forward` | `creation` |

뺀 규칙이 핵심이다.

- **`update`를 원장 브랜치에 넣으면 모든 릴리스가 죽는다.** `update`는 "bypass 권한자 외 ref 갱신
  금지"이고, 원장 갱신 push가 곧 ref update다. UI 체크박스 하나로 생기는 사고라 readback이
  `forbiddenRulesPresent`로 잡는다. 태그에는 넣는다. 태그는 생성 후 갱신되면 안 되고 `creation`과는
  별개 규칙이라 신규 태그 생성은 막지 않는다.
- **`creation`은 양쪽 다 뺀다.** 원장은 초기화 push가 브랜치를 생성하고, 태그는 `release-tag.yml`이
  생성한다.
- **`pull_request`는 불가능하다.** 원장 갱신과 태그 생성은 `git push --atomic` 한 연결에서 일어나야
  한다. PR 경유는 구조적으로 성립하지 않는다.
- **`required_signatures`는 atomic push와 양립하지 않는다.** 서명하려면 REST 커밋 생성으로 가야 하는데
  REST는 ref 두 개의 atomic 갱신을 제공하지 않아 "부분 성공 금지"가 깨진다.
- **`required_status_checks`는 영구 대기를 만든다.** 원장 브랜치에는 CI가 돌지 않는다.

`bypass_actors`는 비운다. 조직 관리자조차 우회할 수 없고, 정말 필요하면 ruleset 자체를 고쳐야 하며
그 변경은 감사 로그에 남는다.

`repository_name`은 `~ALL`이다. `repository_ids` 확장은 앱이 추가될 때마다 사람이 ID를 더해야 해서
영구 드리프트를 만들고, 저장소별 ruleset은 객체 수만 늘린다. `release-version-ledger`는 조직에서 이
용도로만 쓰는 고유 이름이라 그 브랜치가 없는 저장소에는 아무 영향이 없다.

## 적용 절차 (사람)

```bash
# 1) evaluate로 생성
gh api --method POST /orgs/seorilabs/rulesets \
  --input contracts/release-ref-protection.ledger-branch.json
gh api --method POST /orgs/seorilabs/rulesets \
  --input contracts/release-ref-protection.release-tags.json

# 2) shadow 관측 (위반이 잡히는지 확인)
gh api "/orgs/seorilabs/rulesets/rule-suites?time_period=week&rule_suite_result=all"

# 3) Active 승격
gh api --method PUT /orgs/seorilabs/rulesets/<LEDGER_ID> -f enforcement=active
gh api --method PUT /orgs/seorilabs/rulesets/<TAGS_ID>   -f enforcement=active
```

## readback (에이전트)

```bash
node scripts/release/readback-release-ref-protection.mjs \
  --desired contracts/release-ref-protection.ledger-branch.json \
  --desired contracts/release-ref-protection.release-tags.json \
  --repository seorilabs/lord-ledger \
  --out docs/migration/evidence/release-ref-protection-readback-<날짜>.json
```

GET만 한다. `forbiddenRulesPresent`가 비어 있고 `bypassActorsEmpty`가 참이며 `state`가 `ACTIVE`여야
완료다. Active 상태에서 실제 릴리스를 한 번 성공시키는 것이 "봇의 fast-forward push가 막히지
않는다"는 유일한 실증이다.

readback이 실측으로 확인한 두 가지 성질을 알고 봐야 한다.

- **같은 ref를 덮는 ruleset이 둘 이상일 수 있다.** 기존 `Immutable Platform release tags`
  (id 21819735, `seorilabs/platform` 전용, active)가 `refs/tags/v*` 를 덮는다. 그래서 desired와
  관측값을 ref가 아니라 **이름으로** 맞춘다. ref로 맞추면 옛 ruleset을 새 것으로 읽어
  "`non_fast_forward` 규칙이 없다"는 엉뚱한 blocking이 나온다. 중복은 `overlapping-ruleset`
  advisory로 보고하고 정리 여부는 사람이 판단한다.
- **`evaluate` ruleset은 `/repos/{full}/rulesets?includes_parents=true` 에 나타나지 않는다.**
  `active` 인 것만 나온다. 그래서 evaluate 동안 저장소 커버리지는 `false` 가 아니라 `null`
  (아직 알 수 없음)로 보고한다. Active 승격 뒤에만 커버리지를 판정한다.

2026-09-16 관측 결과는
[`docs/migration/evidence/release-ref-protection-readback-2026-09-16.json`](../migration/evidence/release-ref-protection-readback-2026-09-16.json)
에 있다.
