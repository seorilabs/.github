# App Store 1.9.1 사용자 실행 대체 인정

사용자는 “근거로 인정하고 심사제출해.”라고 [승인](https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6269467251)했다. 앱 저장소의 제안 SHA256 `9455f700d9b8ac934089c67cada6d88e1be962ac1da372b3927d37c1f41c9e06`을 고정한다.

기존 1.9.1 연결은 실제 SDK 독립 실행이 없어서 제출을 막는다. 사용자 TestFlight 실행과 같은 시각대의 iOS 서버 SSV 및 지급 기록을 이번 고정 후보의 대체 근거로 인정한다. 사용자 확인은 일반 `runs`에 넣지 않는다. 기기 모델과 OS, 설치 빌드, Test mode 표시는 agent가 확인하지 않았다. 최근50개 ASC 빌드에서 1.9.1은56 하나였고 서버 claim은 사용자 신원 대조 없이 시간으로 연결했다.

## 변경 범위

기존 envelope에 선택적 `ownerEvidence`를 받는다. 원문 확인, 서버 조회, ASC 빌드 조회, 제안, 새 승인 receipt의 원본 문자열과 실제 IPA 해시를 중앙 reviewed grant에 결속한다. 승인 후의 고정 before-release 한 건만 허용한다. 나머지 baseline, patch, native base 해시, 원래 UI 오류3개, 원본 실패, 태그와 tree, 시각 및 만료 검증은 유지한다.

정상 native 검증은 계속 실행하고 원래 `TEST_LEVEL_BELOW_FLOOR platform-first rewarded-ads ios` 오류 하나만 허용한다. 다른 오류, 추가 실행 변조, 증거 누락 및 변경, 다른 마켓, 다른 빌드, 미검증 또는 미지급, 기한 초과는 차단한다. 사용자 확인을 독립 실행 PASS로 바꾸지 않는다. 결과는 `human_exception`, native 원래 verdict는 failed, SDK 상태는 사용자 및 서버 대체 인정으로 구분한다. 별도 SDK 재실행만 이번에 대체하며 일반 SDK 규칙은 유지한다.

## 검증과 종료

L1 개발 테스트로 원본과 수정 실패, 누락 및 변조, 잘못된 서버 상태, 다른 앱과 플랫폼, claim, 버전과 빌드, 승인 및 만료를 검사한다. 기존 정상 SDK 경로와 빌드 전 경로가 유지되는지도 검사한다. 전체 npm test, actionlint, Claude 읽기 전용 교차 리뷰, required CI를 통과한 뒤 실제 후보 before-release CLI 및 CI를 실행한다.

제품과 SDK, 서버, 가격, Android는 바꾸지 않는다. 제출 뒤 또는 원래 만료 `2026-10-26T03:59:05Z`에 iOS grant, 전용 코드와 테스트, 전용 중앙 및 앱 workflow caller를 제거한다. 실제 제출 ID와 상태는 앱 docs에 기록한다.
