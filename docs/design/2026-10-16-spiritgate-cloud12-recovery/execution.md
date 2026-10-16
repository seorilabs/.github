# 실행 기록

- 기준 b1353afe152a72c3d609bd03bb9486182cf58106, 별도 feature/spiritgate-cloud12-recovery.
- 승인 제안SHA256 b1da2d71169aaa53a0d842945c768de5c75031676058fc447212400351481ff0. 직접 승인·원래 만료·기존 실패 기록을 유지한다.
- TDD: 기존 CI namespace 조건에서 실제 관측값을 넣으면 TESTFLIGHT_CI_CONTEXT 실패, 임시 한 조건 보정35건 통과. 새 복구 export/검사 추가 후 구현 전 실패, 구현 후 provider/bootstrap 합계954건 모두 통과했다. 합성 테스트는 제품·기기 실행 근거가 아니다.
- 실제 Apple 읽기 전용 진단(2026-10-16T07:01:56.948Z): 기존 실패12의 CI namespace와 관계·로그 해시를 통과하고 새13이 없으므로 TESTFLIGHT_APPLE_FIRST_BUILD로 정확히 거절했다. 새13 gate 통과라고 세지 않는다. 원문·비밀값은 여기에 게시하지 않는다.
- 서로 다른 unsigned project-only 경로2개에서3142원본/생성2파일 동일 hash/Godot 오류0. 실제 archive·서명·Cloud·업로드 근거는 아니다.
- 전체1521검사 중1520PASS/1FAIL: 기존 npm 인증 테스트의 127.0.0.1 listen EPERM(샌드박스). 해당 파일만 허용 환경에서 재실행2/2PASS. pack/actionlint/diff 통과. PR264 최초 f3a790f의 CI38864980696 성공.
- 실제 자동 Copilot1회는 quota 소진으로 실패했고 재요청하지 않았다. Claude1회는 승인된 코드7파일36392bytes(diff SHA256 a9492dce0ec9951f4fd71a3ef3935638304a0cedf697e97182ec66b3699c4675)만 읽었고 도구/MCP0이다. 이 PR 총 요청2회를 소진했다.
- Claude P2: 생성file hash를 승인 JSON에도 결속하라는 부분 수용. 승인된 proposal 본문에는 두 새 hash가 이미 있었다. 앱 pbxproj는 태그 소스 그대로 두고 export가 build13에 맞춰 만드는 파일이므로 중앙 PR에 앱 소스 변경을 넣으라는 전제는 적용하지 않는다. 실제12→13 생성파일 diff는 CURRENT_PROJECT_VERSION 두 곳의12→13뿐이며 서명 설정은 동일하다. 승인 JSON과 validator에 workingOverrides/profile hash/서명팀 직접 대조를 더했고 원래 승인 시각·proposal bytes는 유지했다. 추가 리뷰 요청 없이 보강 검사와 최종 CI를 기록한다.
- 실제 추가 Cloud 생성0·업로드0·TestFlight 미도달·제품 전체 E2E blocked·iPhone deferred·공개 미완료다.
