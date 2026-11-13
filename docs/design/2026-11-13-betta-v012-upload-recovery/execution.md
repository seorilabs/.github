# 업로드 전용 복구 구현

사람은 불변 제안653f2c0/PR354에 “기존 산출물로 업로드 전용 복구 승인”이라고 답했다. 승인 후 첫 시각은2026-11-13T13:31:41Z다. 승인 기록은 approval.json에 남긴다. 두 native 실행은 이미 실패 종료했으며 추가 native0회, 동일 AAB/IPA의 접수 최대1회/마켓만 허용한다.

`betta-existing-artifact-upload` grant는 새 빌드를 받지 않는다. 정상 build/배포 경로에 이 grant를 넣으면 거부하고, 검토한 로컬 업로드 전용 CLI에서만 사용한다. 등록된 기존 publisher/uploader를 사용한다. 제품 source·태그·원장·서명을 바꾸지 않으며 원래 작업트리·후처리 검사 실패를 그대로 보고한다. source 검증은 새 원본 checkout과 provider가 보존한 고정 산출물의 대조이며 원래 빌드 작업트리 검사의 통과를 뜻하지 않는다.

Google native3개, Apple native4개의 실제 이력·원래 before-build claim·누락된 before-deploy claim·실패 로그·서명 산출물과 market baseline을 읽는다. 새 버전이 이미 접수됐거나 물리 실행이 추가되면 멈춘다. package/version별 원자적 업로드 예약과 원래 producer 차단 기록을 만들고, 예약 응답 불명·중복은 재시도하지 않는다. 정상 제품 QA는 THREE_UI_ROUNDS_REQUIRED/blocked로 유지한다.

이번 PR은 비활성 코드와 승인 기록만 추가한다. 검토·CI 후 실제 verifier revision과 원래 증거 digest를 별도 grant 활성화 PR에서 고정한다. 기기·게임 main·심사·공개·새 자격증명·유료 플랜은 포함하지 않는다.

## 검증

- 신규 grant/0회 native 한도와 context 테스트의 실패를 먼저 기록한 뒤 구현했다.
- Betta 기존·신규 회귀138개 통과. source/태그/digest/SDK/서명, 누적 native 이력, 기존 첫 배포와 복구 경로, 원래 QA 실패, 중복·경합·응답 유실 예약을 검사했다.
- 전체 npm test2,087개 로컬 통과. Node 구문, actionlint, git diff --check 통과.
- 실제 내려받은 AAB(code3)와 App Store IPA(build4)의 readonly 서명 검사는 통과했으나 아직 업로드하지 않았다.
