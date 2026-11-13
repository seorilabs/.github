# v0.1.2 승인 연결

승인된 비활성 구현PR352/b161632에 실제 수정본을 연결한다. 사람의 “중앙 변경까지 승인하고 반영”과 불변 제안aa29c3a를 source 내 승인 문서의 digest로 확인한다.

| 항목 | 값 |
|---|---|
| 게임 source |a65470d2a67308d808a8a8f63583aa1e14cc435e|
| 제품 기준 |479d9c7a803d7446fcce322238c5d74f0d22c112, 이후 출시 연결만 변경|
| 태그·원장 |v0.1.2, Android code3, 태그 workflow43429374682 통과|
| annotated tag object |6c600e91123a343f916139b56b99666c3dce6a51|
| 현재 CI |43427192956 통과,58여정,artifact14039605209,59개 로그에서 Godot 오류0개|
| 작성자 실제 렌더 |40조합400시나리오 통과,200PNG. UI3·성능·native QA 대체 아님|
| 정상 검증 |두 마켓 모두 THREE_UI_ROUNDS_REQUIRED. 원래 L3와 SDK 계획 유지|
| 이전 Play |bundle1, internal1. 나머지 track 비어 있음|
| 이전 Apple |0.1.1/build3 VALID, build/upload ID2d024237-01b3-4f06-a5cd-66ebb794df77|
| 실제 Cloud 이력 |완료된 실패3회 보존, workflow disabled. 시작 전 다음 번호4와 기존 목록을 다시 확인|
| 상한 |새 native1회·접수1회/마켓. 누적 native Android3/Apple4, 접수2회/마켓|
| 만료 |2026-11-19T15:35:59.411730+00:00, 연장 없음|

서명·계정·package·bundle은 기존 등록 값을 재사용한다. 예전 grant는 회수된 상태를 유지하며 실패·claim·태그를 지우지 않는다. 기존18개 관측(이전 실행·실패·승인15개와 현재 작성자/준비 기록3개)을 Release 자산의 고정 digest로 읽는다. 정상 QA를 통과로 바꾸거나 nativeQaWaived를 설정하지 않는다.

이 PR 반영 전에는 새 native/업로드를 시작하지 않는다. 반영 후에도 실제 source·태그·원장·CI·승인·기존 provider 목록과 물리 실행을 다시 검사하고, 원자적 native-start intent와 산출물별 upload intent를 보존한다. 각 마켓 내부 제공을 확인한 뒤 한시 승인을 회수하고 Cloud workflow를 비활성화한다. 기기 사용·게임 main·외부 TestFlight·심사·공개는 제외한다.
