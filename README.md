# Seori Labs Dot Github

Seorilabs organization-wide GitHub defaults, profile content, and operating contracts.

## Fleet Control Plane

신규·이관 저장소의 운영 desired state 정본은 Backoffice다. 저장소 source에서 탐지한 사실과
provider readback은 별도 observation으로 보존하고, 중앙 `WorkflowBundle`에서 생성한 thin
caller만 각 저장소에 둔다.

1. Backoffice의 signed immutable `ConfigRevision`과 resolved manifest
2. [`workflow-bundle-source.yaml`](contracts/workflow-bundle-source.yaml)의 중앙 CI 계약
3. [`fleet-react-native.yaml`](profiles/fleet-react-native.yaml)과 [`fleet-godot.yaml`](profiles/fleet-godot.yaml)의 탐지·실행 profile
4. 중앙 generator가 만든 full-SHA thin caller

기존 `.seorilabs/app.yaml`과 마켓별 JSON은 shadow parity와 rollback이 끝날 때까지만 읽는
legacy input이다. 신규 설정 정본으로 사용하지 않으며 저장소에서 사람이 직접 편집하지 않는다.

- [Fleet Control Plane](docs/fleet-control-plane.md)
- [WorkflowBundle schema](contracts/workflow-bundle.schema.json)
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

이 저장소의 계약 검증은 `npm test`로 실행한다. 로컬 Fleet CLI는 candidate용
`fleet-contract bundle|validate-bundle`만 제공한다. caller 생성·검증은 trusted approval
key, exact GitHub source readback, Backoffice ACTIVE resolved-manifest readback을 가진 GitHub App
reconciler만 library API로 수행한다.
`repo-contract [저장소 경로]`는 legacy shadow 비교 기간 동안 유지한다.

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
