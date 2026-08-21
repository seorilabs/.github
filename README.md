# Seori Labs Dot Github

Seorilabs organization-wide GitHub defaults, profile content, and operating contracts.

## Org Contract v1

새 저장소와 이관 대상 저장소는 다음 우선순위를 따른다.

1. [`contracts/`](contracts/)의 machine-readable 정책과 schema
2. [`profiles/`](profiles/)의 stack별 요구사항
3. 각 앱 저장소의 `.seorilabs/app.yaml`과 앱 고유 설정
4. [재사용 워크플로우](.github/workflows/)와 설명 문서

설명 문서와 실행 가능한 계약이 충돌하면 같은 `schemaVersion`의 `contracts/`와
`profiles/`가 우선한다. 앱 저장소에는 조직 정책 전문을 복사하지 않고 앱 고유 선언과
승인된 예외만 둔다.

- [App contract schema](contracts/app.schema.json)
- [Test policy](contracts/test-policy.yaml)
- [Review policy](contracts/review-policy.yaml)
- [Release policy](contracts/release-policy.yaml)
- [Agent policy](contracts/agent-policy.yaml)
- [React Native profile](profiles/react-native.yaml)
- [Godot profile](profiles/godot.yaml)
- [Repository contract CLI](packages/repo-contract/)
- [Org Contract v1 rollout](docs/migration/org-contract-v1-rollout.md)
- [P5 cleanup inventory](docs/migration/p5-cleanup-inventory.md)

이 저장소의 계약 검증은 `npm test`로 실행한다. 앱 저장소 검증기의 실행 인터페이스는
`repo-contract [저장소 경로]`다.

## Docs

- [Contribution guidelines](CONTRIBUTING.md)
- [Pull request template](PULL_REQUEST_TEMPLATE.md)
- [GitHub Project operations](docs/project-management/seorilabs-github-project-operations.md)
- [Execution ticket template](docs/project-management/seorilabs-execution-ticket-template.md)
- [Agent contribution system](docs/agent-governance/seorilabs-agent-contribution-system.md)
- [Agent contribution contract](docs/agent-governance/agent-contribution-contract.md)
- [Agent skills design](docs/agent-governance/seorilabs-agent-skills-design.md)
- [Spec and versioning policy](docs/agent-governance/spec-versioning-policy.md)
- [Org CI/CD & release system — legacy migration reference](docs/ci-cd/org-cicd-release-system.md)
- [Build toolchain contract](docs/ci-cd/build-toolchain-contract.md)
