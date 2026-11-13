# 생성된 0.1.2 산출물의 업로드 전용 복구안

0.1.2 수정본은 아직 두 내부 채널에 반영되지 않았다. 이전 Play0.1.0/code1과 TestFlight0.1.1/build3을 유지한다. 이번 승인에 따라 native를 각각 한 번 실행했으나 업로드 전 단계에서 실패했다. 새 native 한도는 모두 사용했으므로 재빌드·run 재실행을 하지 않는다. 이 PR은 기존 grant 회수와 복구 제안만 포함하며 새 업로드 경로를 구현·활성화하지 않는다.

## 실제 결과

제품source는 `a65470d2a67308d808a8a8f63583aa1e14cc435e`, 태그v0.1.2와 원장code3은 그대로다. CI58여정과 작성자 실제 렌더40조건400시나리오는 통과했다. 원래 L3/UI3·성능·네이티브 미완료와 정상 검증 `THREE_UI_ROUNDS_REQUIRED`는 보존한다.

Android 실행43431697154는 서명 AAB를 만들었지만 `BETTA_UNTRACKED_SOURCE "tools/__pycache__/pinned_download.cpython-313.pyc"`에서 멈췄다. 업로더는 skipped이며 before-deploy claim은 없다. 캐시의 실제 바이트가 보존되지 않았으므로 원래 전체 작업트리 검사를 통과했다고 주장하지 않는다.

iOS Cloud실행f86f9acf-b194-4a10-af9d-c5bbc1b9b02a/build4는 App Store 서명 산출물을 만들었지만 후처리 실패로 내부 배포가 skipped됐다. before-build claim은 있고 before-deploy claim은 없다. 후처리 로그에는 `added 7 packages in 738ms`만 남아 있다. npm 설치 성공과 이후 실패를 구분하며 직접 원인은 미확정이다. Cloud workflow는 실제 FAILED/COMPLETE 확인 후 비활성화했다.

| 산출물 | 고정할 실제 값 |
|---|---|
| AAB provider artifact |14039879273, failed-godot-google-play-aab-43431697154-1|
| AAB archive digest |9b653eb008bc074395a13fa47d5174339147182eebeb9b6930ee073c63bf2a60|
| AAB 파일 digest |136e213a636c534d53f5ded35b911b6127039478e35dec8b01c8ac0ffbde7c77|
| AAB 검증 |com.seorilabs.bettaraising/0.1.2/code3, SDK26/36, portrait, JAR 서명·기존 인증서 일치|
| Apple provider artifact |ace1f3ab-1750-46bc-9df0-c5a0c54c5acf, BettaAtelier 0.1.2 app-store.zip|
| Apple archive digest |e31ac18dc4f5131bf793e509b1de29e4f639714a0b46cbf412399609ff4ae147|
| IPA 파일 digest |188b36af4f7490fc85a7b82355af8efd9378b7e3c06b6f6bc697f1efe8ce485e|
| 서명 앱 tree digest |203a0c69627fbbec3891cfad9ea87ad909e4651c8f62a5b9d1b6c1ce7cb9a550|
| Apple 검증 |com.seorilabs.bettaraising/0.1.2/build4, Apple anchor 서명·기존 인증서/프로필·entitlements·개인정보 manifest 일치|

## 추가 승인 요청 범위

새 native 빌드는 **0회**, 기존 두 산출물을 그대로 사용하는 업로드만 마켓당 최대1회다. 누적 native Android3/Apple4와 접수 최대2회/마켓을 유지한다. 제품source·태그·원장·기존 서명은 바꾸지 않는다. 새 승인 근거는 중앙의 불변 제안과 사람 회신에 연결한다. 필요한 중앙 검증기와 업로드 전용 thin consumer만 추가하며 빌드·export·재서명 명령을 포함하지 않는다.

기존 전체 작업트리 검사의 실패를 통과로 바꾸지 않는다. 원래 CI 실행·실패와 provider가 보존한 정확한 서명 산출물을 근거로 삼는 한시 복구 경로를 별도로 검토한다. raw archive와 내부 AAB/IPA digest, 실제 source/run/attempt, SDK·식별자·서명·현재 market baseline을 모두 대조한다. 이전 grant 회수와 늦은 producer 차단, package/version별 원자적 업로드 예약, 응답 불명 시 재시도 금지를 유지한다.

기존 Play code1, Apple0.1.1/build3만 있는 상태를 실행 직전에 다시 확인한다. 새 버전이 이미 접수됐거나 미등록 항목·서명/source 차이·접수 불명이 있으면 멈춘다. 두 내부 채널의 실제 제공을 재조회하고 한국어·영어 테스트 노트를 저장 후 읽어 확인한다. 만료는2026-11-19T15:35:59.411730+00:00을 연장하지 않는다. 기기 사용·게임 main 반영·외부 TestFlight·심사·공개·새 자격증명·유료 플랜은 제외한다.

L1/dev로 잘못된 source/producer/artifact/digest/signature, native 명령 배제, 기존 상태 보존, 중복·경합·접수 불명, 정상 QA 실패 보존을 검사한다. 기존 복구 경로 회귀와 중앙 전체 테스트·코드 리뷰를 수행한다. 증적은 NAS1dual에서 파일별 크기와 SHA-256을 재읽어 보관한다.

예상 추가30~60분이며 새 유료 플랜이나 native 과금 실행을 추가하지 않는다. 지금까지의 승인은 원래 작업트리 검사를 우회하는 새 산출물 복구를 포함하지 않았으므로 이 제안은 사람 승인 전 구현·활성화하지 않는다.
