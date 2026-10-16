# 실행 기록

- 기준 b1353afe152a72c3d609bd03bb9486182cf58106, 별도 feature/spiritgate-cloud12-recovery.
- 승인 제안SHA256 b1da2d71169aaa53a0d842945c768de5c75031676058fc447212400351481ff0. 직접 승인·원래 만료·기존 실패 기록을 유지한다.
- TDD: 기존 CI namespace 조건에서 실제 관측값을 넣으면 TESTFLIGHT_CI_CONTEXT 실패, 임시 한 조건 보정35건 통과. 새 복구 export/검사 추가 후 구현 전 실패, 구현 후 provider/bootstrap 합계954건 모두 통과했다. 합성 테스트는 제품·기기 실행 근거가 아니다.
- 실제 Apple 읽기 전용 진단(2026-10-16T07:01:56.948Z): 기존 실패12의 CI namespace와 관계·로그 해시를 통과하고 새13이 없으므로 TESTFLIGHT_APPLE_FIRST_BUILD로 정확히 거절했다. 새13 gate 통과라고 세지 않는다. 원문·비밀값은 여기에 게시하지 않는다.
- 서로 다른 unsigned project-only 경로2개에서3142원본/생성2파일 동일 hash/Godot 오류0. 실제 archive·서명·Cloud·업로드 근거는 아니다.
- pack/actionlint/diff 통과. 전체 회귀·PR CI·제한 Claude 검토는 진행 중이다.
- 실제 추가 Cloud 생성0·업로드0·TestFlight 미도달·제품 전체 E2E blocked·iPhone deferred·공개 미완료다.
