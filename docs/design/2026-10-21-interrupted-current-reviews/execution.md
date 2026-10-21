# L1 dev 계약 실행 기록

Issue #298과 같은 폴더의 승인 설계 및 테스트 계획을 따른다. 합성 fixture의 중앙 계약 검사이며 제품 UI 실행이나 출시 gate 결과가 아니다.

요구사항 실패는 기존 스키마가 실제 부분 중단을 보존하는 선택 입력을 거절하는 것으로 재현했다. 새36검사 중32통과와4실패를 기록했으며 문법이나 환경 오류가 아니었다. schema와 verifier 수정 뒤 기존 두 이력 복구 검사와 신규 검사의106개가 통과했다. 이후 과거 회차와 정상/v1의 실제 회귀도 포함했다.

첫 전체 실행에서 엄격 스키마의 anyOf 배열 type 선언과 정책 YAML의 대응 스키마 누락2건을 발견했다. 두 원본 로그를 보존하고 선언을 수정했다. 마지막 전체 실행은1736검사 모두 통과했다. package 검사,actionlint와 git diff 검사도 통과했다. 앱 UI와 기기,빌드,업로드는 실행하지 않았다. PR 전 작성자와 다른 검수자의 핵심 diff 확인에서 수정 필요 사항은 없었다.

외부 보존 로그 이름은 `red.log`, `green.log`, `npm-test.log`, `npm-test-strict-corrected.log`, `strict-schema-green.log`, `npm-test-after-schema-binding.log`, `pack-check-after-schema-binding.log`, `actionlint.log`다. 앞선 실패를 마지막 성공으로 지우지 않는다. 최종 HEAD의 로컬 모델 리뷰와 PR의 실제 required CI 및 원격 squash 결과는 별도 실제 readback으로 확인한다.
