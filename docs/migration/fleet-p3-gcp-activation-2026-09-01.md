# P3 GCP 설치 완료 — 2026-09-01 UTC

GCP 기반 설정은 실제 적용과 별도 재조회를 완료했다. P3 전체 완료는 아니다.
GitHub App 권한·신뢰된 실행기, RN/Godot 시험 빌드, 승인 registry 증거는 별도로 남아 있다.

## 실제 적용 결과

2026-09-01 14:25:01 UTC, `seorilabs-ci` 프로젝트 `321365398093`에서 확인했다.
사용자가 승인한 기존 provisioner의 임시 설치 권한은 `2026-09-01T15:46:47Z`까지다.
임시 설치 권한의 만료와 이번에 설정한 운영 계정의 권한은 서로 별개다.

| 확인 대상 | 결과 |
| --- | --- |
| 빌드·인증용 서비스 계정 | 12/12 생성, 비활성 계정 없음 |
| 지정된 리소스별 IAM 권한 | 74/74 일치 |
| 필수 API | 10/10 활성화, 누락됐던 STS API 활성화 |
| GitHub·MicroK8S 인증 연결 | 2/2 활성, issuer·audience·조건·매핑 일치 |
| 기존 IAM 권한 | 18개 정책의 46개 기존 권한 모두 보존 |
| 새 계정의 사용자 관리 정적 키 | 12개 계정 재조회, 0개 |

적용 프로그램의 `ready: true` 외에도 별도로 47개 조회를 실행했다. IAM 정책 30개,
서비스 계정 키 목록 12개, provider 2개, pool·API 목록·계정 목록 각 1개를 확인했다.
기존 앱 signing/runtime secret 값은 읽거나 변경하지 않았다.

적용 source는 `3ef4ad7eccfeed341472d680ddd731fa0712f575`, 계약 digest는
`f4ba134db84d8bfa3e0b69724e44d843186beae729f94a9619528dd170d746b7`다.
신뢰된 reusable workflow 실행 SHA는 `e21b8da8e45a3379bdae2978522a6ac4b6d7f8f1`로 유지했다.
공개 결과와 검증 수치는 [재조회 기록](evidence/fleet-p3-gcp-2026-09-01.json)에 보관한다.

## 실행 중 확인·수정한 사항

- 권한 거부 문구에 `does not exist`가 포함돼도 리소스 부재로 오판하지 않는다.
- `json(bindings)`가 정상적인 빈 IAM 정책을 `null`로 투영하는 문제를 제거했다.
- 기존 기한부 권한을 보존하면서 조건 없는 운영 권한은 `--condition=None`으로 명시한다.
- 최초 계정 생성은 GCP의 분당 생성 한도로 중단됐다. 4개 계정과 API 반영 상태를 재조회한
  뒤 같은 승인 범위로 재개했다. 기존 계정을 삭제하거나 새 정적 키로 우회하지 않았다.

관련 회귀 테스트 37개가 통과했다. 동일 source의 전체 테스트는 732개 통과, 실패 0개,
명시적으로 별도 실행하는 cold-cache 통합 테스트 2개 제외다. 워크플로 문법 검사와
패키지 검증도 통과했다. 이 결과를 실제 앱 artifact 빌드 성공으로 간주하지 않는다.

## 다음 사람 작업 — 기존 GitHub App 권한 추가

기존 App `seorilabs-backoffice`의 공개 identity와 조직 전체 설치는 정상이다.
설치 `142120077`의 현재 권한을 재조회했으며 아래 추가 권한은 아직 반영되지 않았다.
새 GitHub App·API key·개인 토큰을 만들 필요는 없다.

1. [기존 App 권한 설정](https://github.com/organizations/seorilabs/settings/apps/seorilabs-backoffice/permissions)에서
   기존 권한을 유지하고 다음 항목을 추가한다.

   | 구분 | 항목 | 필요한 권한 |
   | --- | --- | --- |
   | Repository | Administration | Read and write |
   | Repository | Environments | Read and write |
   | Repository | Pull requests | Read and write — 현재 Read에서 변경 |
   | Repository | Workflows | Read and write |
   | Repository | Custom properties | Read and write |
   | Organization | Administration | Read and write |
   | Organization | Custom properties | Admin |

2. 이벤트 구독에 `Repository`를 추가하고 저장한다. 기존 이벤트는 유지한다.
3. [조직의 기존 설치](https://github.com/organizations/seorilabs/settings/installations/142120077)에서
   추가 권한을 승인한다. 저장만 하고 설치 승인을 생략하면 기존 설치 권한은 바뀌지 않는다.

그 후 `node scripts/fleet/bootstrap-p3-github.mjs readback`으로 확인한다.
App key·webhook의 안전한 복구와 신뢰된 실행기 검증도 별도 gate로 남아 있으므로
App 권한 추가만으로 전체 bootstrap이나 시험 빌드가 완료된 것으로 기록하지 않는다.

실제 RN/Godot 시험 빌드는 기존 [Happy Farm #497](https://github.com/seorilabs/happy-farm/issues/497),
[Lizard Tycoon #521](https://github.com/seorilabs/lizard-tycoon/issues/521)에서 추적한다.
이 적용에서는 마켓 업로드·심사 제출·공개 출시와 ruleset Active 전환을 수행하지 않았다.
