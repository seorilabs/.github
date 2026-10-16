# 실행 결과

- 설계의 직접 사용자 승인 후 최소 보정을 적용했다. 합성 표시 전환 회귀는 기존 코드에서 TESTFLIGHT_UI6_SNAPSHOT_SCOPE로 RED, 보정 후 입력 훼손/정상 경로 거절을 포함해 GREEN이다.
- Node24.16.0/npm 기존 실행 환경에서 전체1467건 통과, package/diff 검사 통과. 초기 테스트 환경의 Node/npm PATH 누락은 별도로 남겼으며 기능 RED 근거로 사용하지 않는다.
- 실제 원문94개 다운로드 bytes와 고정 Git 소스3142파일을 대조했다. 집계는 정정 SHA abb30a5a5cdfa42f1dc5e1852e8a710cbffc36be5b76d4fc506083ee14663483, asset646255342다. 이전 집계asset646232039는 원문 보존을 위해 남겼으며 grant에 연결하지 않는다.
- 실제 데이터의 UI5/6/7/8/9/Mac skip 이력 검사 오류0. 전체 preflight는 아직 미실행인 reviewed main과 실제 Cloud provider run2조건만 차단한다. 이를 전체 검증 통과라고 기록하지 않는다.
- 다음 Cloud 번호12를 실제 Apple UI에서 읽었고 서로 다른 두 경로의 unsigned project 해시가 일치했다. 실제 서명/Cloud/업로드는 아직0이다.
- 첫 내부 뒤 실제 iPhone·예외 인자 제거·공개1.1.1 정상v2/L3·E2E·UI/실기기·심사/공개/live 조건을 유지한다.
