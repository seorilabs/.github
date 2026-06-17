# Seorilabs Agent Skills Design

## 목적

Seorilabs org의 agent contribution을 두 종류의 skill로 나눈다.

- Contributor skill: 원격 Claude/Codex가 repo에 변경을 만들고 PR을 생성할 때 사용한다.
- Integrator skill: 들어온 PR을 수용, 보정, merge readiness, Project 상태 갱신까지 처리할 때 사용한다.

두 skill은 같은 contract와 Project schema를 읽지만, 책임을 섞지 않는다.

## Skill 1: `seorilabs-contribute-pr`

용도:

- Seorilabs repo에서 agent가 새 작업을 시작한다.
- Issue/Project ticket 기반으로 작은 변경을 만든다.
- 검증 증거를 남기고 PR을 생성한다.
- Claude 또는 Codex 원격 루틴이 무작위 작업 대신 queue 기반 작업을 하게 한다.

Trigger description 초안:

```yaml
name: seorilabs-contribute-pr
description: Create controlled Seorilabs repository contributions from GitHub Issue or Project tickets. Use when Codex or another agent needs to select or execute a Seorilabs org task, sync from the default branch, apply a small scoped change, run repo-local verification, write a Korean PR description with ticket/spec/version evidence, and avoid planning or release actions that require human approval.
```

핵심 workflow:

1. repo default branch와 remote state를 확인한다.
2. 연결 티켓 또는 Project item을 찾는다. 없으면 새 장기 작업을 시작하지 않는다.
3. source-of-truth 문서를 읽는다.
4. scope, approval, version impact를 정리한다.
5. branch를 만든다.
6. 최소 변경을 구현한다.
7. repo-local test/smoke를 실행한다.
8. PR description에 ticket/spec/version/verification을 적는다.
9. Project item을 `Review`로 이동하거나 이동 준비 상태를 보고한다.

필요 references:

- `agent-contribution-contract.md`
- `spec-versioning-policy.md`
- `seorilabs-github-project-operations.md`
- `seorilabs-github-project-schema.yml`
- Seorilabs AGENTS.md 공통 지침

## Skill 2: `seorilabs-integrate-pr`

용도:

- Seorilabs repo에 들어온 agent PR을 triage한다.
- 무작위 PR을 ticket/spec/test/version 기준으로 분류한다.
- 필요한 보정 커밋을 만들거나 contributor에게 rework를 요청한다.
- merge, release, Done 이동 전에 gate를 확인한다.

Trigger description 초안:

```yaml
name: seorilabs-integrate-pr
description: Triage, repair, and prepare incoming Seorilabs agent pull requests for review, merge, QA, or rejection. Use when Codex needs to inspect Claude/Codex/Gemini Bot PRs in Seorilabs org repos, verify ticket links, Project fields, spec and version impact, CI/review evidence, approval gates, source-of-truth updates, and decide whether to accept, request rework, split, close, or prepare release follow-through.
```

핵심 workflow:

1. PR, branch, linked issue, Project item을 확인한다.
2. contract 충족 여부를 점검한다.
3. CI, review bot, unresolved comments, ruleset, required checks를 확인한다.
4. 변경 diff가 티켓 scope와 맞는지 본다.
5. version impact와 source-of-truth update를 확인한다.
6. 결함이 작고 명확하면 보정 커밋을 만든다.
7. 결함이 크면 `Needs ticket/spec/tests/split/approval`로 분류한다.
8. merge 가능한 경우 merge 후 Project와 docs 상태를 갱신한다.
9. release 영향이 있으면 release approval 전에는 배포하지 않는다.

필요 references:

- `agent-contribution-contract.md`
- `spec-versioning-policy.md`
- `seorilabs-github-project-operations.md`
- `seorilabs-github-project-schema.yml`
- repo-local release/readiness docs
- GitHub ruleset/branch protection 확인 절차

## Skill 3 후보: `seorilabs-spec-versioning`

처음부터 별도 skill로 만들 필요는 없다. Contributor와 Integrator skill의 reference로 시작하고, 반복 사용이 많아지면 분리한다.

분리 조건:

- 여러 repo에서 version impact 판단이 계속 흔들림
- release note, changelog, store metadata, remote config template 갱신이 반복됨
- app/game별 spec schema가 안정화됨

## Skill 파일 구조 제안

`$CODEX_HOME/skills` 아래에 둘 경우:

```text
seorilabs-contribute-pr/
  SKILL.md
  agents/openai.yaml
  references/
    agent-contribution-contract.md
    spec-versioning-policy.md
    project-operations.md
    project-schema.yml

seorilabs-integrate-pr/
  SKILL.md
  agents/openai.yaml
  references/
    agent-contribution-contract.md
    spec-versioning-policy.md
    project-operations.md
    project-schema.yml
```

이 repo를 canonical source로 둘 경우, skill references는 이 repo 문서를 복사하거나 sync script로 갱신한다. Codex skill은 현재 로컬 `$CODEX_HOME/skills` 아래에 있어야 자동 discover가 쉽다.

## Skill 생성 전 결정 필요

- 실제 skill을 `$CODEX_HOME/skills`에 바로 만들지, `.github` repo에 source copy를 먼저 둘지
- Claude 원격 루틴이 읽을 instruction 파일명: `CLAUDE.md`, `AGENTS.md`, 별도 prompt bundle 중 선택
- Project item 조회/수정에 사용할 권한: `gh auth refresh -s project` 또는 GitHub App installation token
- Integrator skill이 merge까지 할지, merge readiness report까지만 만들지
