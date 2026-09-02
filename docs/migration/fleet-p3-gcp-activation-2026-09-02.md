# P3 GCP WIF provider 전환 — 2026-09-02 UTC

Cloud Build용 GitHub WIF provider `fleet-p3/github-cloud-build`의 신뢰 `job_workflow_ref`를
WorkflowBundle v5 후보 `2e9b6afd0c0b02f691ecaf1fa0055cadb57e972c`로 전환했다. 직전 SHA
`e21b8da8e45a3379bdae2978522a6ac4b6d7f8f1`은 `wif.supersededWorkflowExecutionShas`로 열거해
exact 쌍 조건만 전환 대상으로 인식했고, 다른 조건은 여전히 `P3_GITHUB_WIF_PROVIDER_DRIFT`다.
계약 변경은 [#102](https://github.com/seorilabs/.github/pull/102)로 병합했다.

## 실제 적용 결과

2026-09-02 12:5x UTC, `seorilabs-ci` 프로젝트 `321365398093`에서 확인했다. 사용자가 승인한
provisioner의 기한부 installer 권한(`p3-installer-20260902`, `2026-09-02T16:00:00Z` 만료)으로
`plan → readback → apply fleet-p3-11a494e936e0 → readback`을 실행했다.

| 확인 대상 | 적용 전 readback | 적용 후 readback |
| --- | --- | --- |
| GitHub provider | 존재, `configurationExact: false` (직전 SHA 쌍 조건), 활성 | 존재, `configurationExact: true`, 활성 |
| MicroK8S provider | exact, 활성 | exact, 활성 |
| WIF pool | exact, ACTIVE | exact, ACTIVE |
| 필수 API | 10/10 | 10/10 |
| 서비스 계정 | 12/12 존재, 비활성 없음 | 12/12 |
| 리소스별 IAM binding | 74/74 | 74/74 |
| 새 정적 키 | 0 | 0 |
| `ready` | false | true |

apply는 provider를 disable → `update-oidc`(새 조건) → 재검증 → enable 순서로 좁혔고 IAM binding은
재확인만 했다. 라이브 provider 조건에는 `@2e9b6af…` 조합 4개만 남았다. 공개 결과와 digest는
[재조회 기록](evidence/fleet-p3-gcp-2026-09-02.json)에 보관한다.

## 함께 확인한 사항

- 두 시범 앱 `internal` Environment의 `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`,
  `SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT`, `SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT`가
  계약의 `cloudBuild.githubActions.repositoryBindings`와 exact 일치한다 (사용자가 직접 설정).
- 마켓 업로드, 심사 제출, 공개 배포, 앱 signing 교체, 정적 키 생성은 하지 않았다.

## 남은 gate

- 두 시범 앱의 실제 build-only run과 artifact 검증: [중앙 #42](https://github.com/seorilabs/.github/issues/42).
