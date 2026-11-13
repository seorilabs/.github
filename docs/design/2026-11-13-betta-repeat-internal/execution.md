# 단일 내부 업데이트 구현 기록

사람은 제안 `aa29c3a48e82c1c59f44f8608484cb7b0f321d6e`에 대해 “중앙 변경까지 승인하고 반영”이라고 답했다. 첫 승인 후 시각은 2026-11-13T12:19:41Z이며 원래 만료는 연장하지 않는다. 게임 main 반영, 기기 사용, 심사·공개는 승인 범위가 아니다.

기존 `betta-first-internal`의 빈 마켓 조건과 두 번 한도를 유지한다. 신규 `betta-internal-update`만 이전 Play 코드·track 및 Apple build·upload ID를 정확히 대조하고, 물리 실행과 claim 모두 한 번으로 제한한다. 결과의 정상 QA 차단을 보존한다. 원본 UI479d9c7 이후에는 승인 문서, App Store 테스트 메타데이터와 Xcode Cloud 소비자만 달라질 수 있다. 승인 문서는 불변 중앙 제안의 digest에 연결한다.

이 PR은 비활성 코드만 추가한다. 실제 최종 source·태그·원장·CI·설정·서명·provider 기준은 별도 활성화 PR에서 검토한다. 기존 grant를 되살리거나 이력을 초기화하지 않는다.

## 개발 환경 검증

- 기존 구현에서 신규 grant와 1회 한도 테스트가 실패하는 것을 먼저 기록했다. `update-contract-red.log`는 앱 작업의 build 증적에 보존한다.
- 신규와 기존 Betta 회귀 111개 통과. 기존 AAB/IPA 복구·서명·빈 마켓·실제 producer·동시 claim 검사도 포함한다.
- 전체 `npm test`: 2,060개 통과, 실패 0개.
- native 빌드·업로드·기기 실행은 아직 하지 않았다. 기존 정상 QA 실패를 통과로 기록하지 않는다.
