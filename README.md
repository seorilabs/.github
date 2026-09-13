# Seori Labs Dot Github

Seorilabs organization-wide GitHub defaults, profile content, and operating contracts.

## 운영 계약

앱 저장소는 중앙 재사용 워크플로를 부르는 얇은 caller만 둔다. 릴리스 태그가 버전의 유일한
정본이고, Apple archive와 업로드는 Xcode Cloud에서만 한다.

- [App contract schema](contracts/app.schema.json)
- [Test policy](contracts/test-policy.yaml)
- [Review policy](contracts/review-policy.yaml)
- [Release policy](contracts/release-policy.yaml)
- [Release version authority](contracts/release-version-authority.yaml)
- [Release version authority caller migration](contracts/release-version-authority-migration.yaml)
- [Agent policy](contracts/agent-policy.yaml)
- [Autonomous issue policy](contracts/autonomous-issue-policy.yaml)
- [React Native profile](profiles/react-native.yaml)
- [Godot profile](profiles/godot.yaml)
- [Repository contract CLI](packages/repo-contract/)
- [Org Contract v1 rollout](docs/migration/org-contract-v1-rollout.md)
- [P5 cleanup inventory](docs/migration/p5-cleanup-inventory.md)

이 저장소의 계약 검증은 `npm test`로 실행한다. `repo-contract [저장소 경로]`는 앱 저장소의
계약 준수를 로컬에서 확인한다.

## Docs

- [Contribution guidelines](CONTRIBUTING.md)
- [Pull request template](PULL_REQUEST_TEMPLATE.md)
- [GitHub Project operations](docs/project-management/seorilabs-github-project-operations.md)
- [Execution ticket template](docs/project-management/seorilabs-execution-ticket-template.md)
- [Agent contribution system](docs/agent-governance/seorilabs-agent-contribution-system.md)
- [Agent contribution contract](docs/agent-governance/agent-contribution-contract.md)
- [Autonomous issue registration](docs/agent-governance/autonomous-issue-registration.md)
- [Autonomous issue routine](docs/agent-governance/autonomous-issue-routine.md)
- [Agent skills design](docs/agent-governance/seorilabs-agent-skills-design.md)
- [Spec and versioning policy](docs/agent-governance/spec-versioning-policy.md)
- [Org CI/CD & release system — legacy migration reference](docs/ci-cd/org-cicd-release-system.md)
- [Build toolchain contract](docs/ci-cd/build-toolchain-contract.md)
- [Release version authority](docs/ci-cd/release-version-authority.md)
- [Release version authority caller migration](docs/migration/release-version-authority-callers.md)
