# 첫 내부1.1.0 근거 이력 보정과 실제 후보 등록

상태: **사용자 승인 후 보정 구현·회귀·CI 완료, PR 병합 대기.** 승인 전 제안 원본은 approval.json의 proposalSha256으로 별도 보존하며 아래 내용은 승인 범위와 실행 후 상태를 함께 기록한다. 현재 고정 후보 v1.1.0/dc7ebea, Android 번호1000015, 다음 Cloud 번호12다. 실제 Cloud 빌드·업로드0이며 원래 만료2026-10-20T23:16:52.580641Z와 한 후보/한 Cloud/한 업로드를 유지한다.

## 문제와 실제 근거

전체 집계 문서와 원문94개를 실제 다운로드 bytes로 대조하고, 고정 소스3142파일을 원래 Git blob과 비교했다. 중앙 전체 합성 검사1450건은 통과하지만 실제 이력 입력은 `TESTFLIGHT_UI6_SNAPSHOT_SCOPE`에서 차단된다. 합성 검사 통과로 이를 무시하지 않는다.

UI6 시작 원문은 첫 분리 창 지문57c0d16f…를 기록했고, 최종 설정 원문은 내장 창 복구 뒤 지문cd0954ce…를 기록했다. 최종 원문의 runtimeDisplayHistory가 첫 지문·Run PID·실제 시작/종료·게임 입력0과 내장 창 복구 시각·공용 설정 미변경을 함께 보존한다. 둘 다 UI7 승인에 이미 고정된 원본 bytes다. 중앙 검증기가 단일 지문만 가정해 실패 이력의 실제 전환도 거절한다.

- UI6 configuration 원본 f753bda86d041e3db9fa5aaa4d1abef5d66227b2ea745b7d54fd672ebb089639, asset643393502.
- UI6 execution-start 원본471d594f10b25ffb41f6f6b5c52359e1f6b0f93ebe5888136706c2f4e51e32e6, asset643393503.
- UI5/7/8와 Mac skip 각 원문의 별도 검증은 일치했다. UI9 집계 상태2필드 보정 후에는 UI9 원문 검사도 일치한다.
- 상세 진단: `/private/tmp/sgd-internal110-aggregate-preparation-v2-20261016/actual-data-preflight.json`, `historical-diagnostic.json`.

## 최소 구현 범위

`validateBootstrapHistoricalUi6`의 **Mac skip이 명시된 실패 UI6 이력에만** 다음 분리 창→내장 창 기록을 대조한다. 정상 검수·다른 마켓·공개 검증·실기기 검사에는 적용하지 않는다.

1. UI6 기능/UX가 둘 다 실패이고 기존 end/failure 원문의 실패·미완료 판정을 유지한다.
2. 기존 정확한 원본 해시·승인 연결·소스3142파일과 기존 모든 source/manifest/clock 검사는 유지한다.
3. runtimeDisplayHistory가 정확히2건이고 첫 기록의 분리 창 종류·시작 지문·원래 시작시각·소유 PID·게임 입력0을 확인한다.
4. 두 번째 기록이 내장 창 복구이고 공용 설정 변경false·복구 권한 기록·첫 Run 종료≤복구≤원래 failed segment 종료 순서를 확인한다.
5. 이 조건을 만족할 때만 서로 다른 시작/최종 지문을 실패 이력으로 허용한다. 생략을 통과로 바꾸거나 새로운 실행을 인정하지 않는다.

제안 코드 diff: `/private/tmp/sgd-internal110-aggregate-preparation-v2-20261016/proposed-failed-ui6-history.patch`. 현재 PR에서 적용했고 실행 결과는 execution.md에 기록했다. 새 schema·새 waiver 필드·검증 우회 입력은 추가하지 않는다.

등록으로 인해 기존 "미등록 ID" 테스트가 실제 등록 ID를 쓰게 된 점은 가상의 미등록 ID로 바로잡는다. 테스트가 인터넷이나 실제 Apple/GitHub 상태를 가정하지 않게 한다.

## 집계 JSON2필드 정정

새 집계의 UI9 functional/ux status를 failed에서 blocked로 정정한다. UI9 원문은 incomplete·0PASS이며, 원문·시각·오류·기한·파일 bytes는 바꾸지 않는다.

- 기존 집계 asset646232039/SHA0e3639396279e5f35c195241ed5e66bf68720bafb157a89e5a3b3bbc63d5ac9d는 보존하고 후보 검증에 사용하지 않는다.
- 정정 파일: `/private/tmp/sgd-internal110-aggregate-preparation-v2-20261016/aggregate.corrected-ui9-status.json`.
- 정정 SHA256: abb30a5a5cdfa42f1dc5e1852e8a710cbffc36be5b76d4fc506083ee14663483.
- 목적지: 기존 비공개 seorilabs/spiritgate-defenders development-evidence release411920958. 새 JSON1파일만 전송·재다운로드 대조하며 기존 자산을 덮어쓰지 않는다. 인증 저장·토큰·자격증명·PixelLab 원본은 없다.

## 실제 첫 내부 grant

고정 dc7ebea/v1.1.0/1000015·기존 Apple 앱6792205995/productE5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB/workflow45B83B98-ABE4-48C1-83FC-09CF3F79651E·기존 production profile bytes만 등록한다. Android 기반4는 실제 독립 실행의 핵심 통과와 상세 미검증을 함께 보존하고, iPhone은 deferred, 제품E2E는 blocked, 공개 허용false다.

실제 다음 번호12로 두 별도 경로에서 unsigned project-only를 생성해 두 tracked 변경 파일이 같은 bytes임을 확인했다. workingOverrides는 before-build{}와 before-deploy의 project.godot/실제 project.pbxproj2개만 허용한다.

- project.godot SHA2562a5633b0c4ed15e154cec2918e512fd4acb5ea7d46ded03190eed1c94e96af3b.
- pbxproj SHA25680c61633dd0951b7622f8aa1128bd9fc0a6ecc507d3d6fcaecc07f7c74f027e8.
- profile SHA25676d422cd8dd2e7df91065cb54b2196c69795f9edde5ddd6e862f2c801f089b4d.

Ready PR·필수 검사·교차 리뷰 후 같은 기존 workflow에 비밀이 아닌 `INTERNAL_TESTFLIGHT_BOOTSTRAP_ID=spiritgate-1.1.0-first-internal`와 기존 개발 QA 참조 `CONFIGURATION_FINGERPRINT=e90f43fdd5ccce42c067bcd87bb690cb0ac90697848611ce2f07ff292445c848`를 연결한다. 기존 승인된7개 숨김 변수는 읽거나 바꾸지 않는다. 시작 직전 실제 다음 번호12·INTERNAL_ONLY·이 후보 run0·태그/원장·승인 기한을 재조회한다. 불일치면 Cloud를 시작하지 않는다.

## 검증·리뷰

중앙 L1/dev의 다음 검증을 수행한다. 이것은 제품 QA가 아니다.

- 최소 합성 RED→GREEN: 실패 UI6의 명시된 실제 표시 전환을 보존하며 원래 UI6 fail/incomplete0PASS를 유지.
- 음성 입력: Mac skip없음·UI6 PASS로 변조·잘못된 시작 지문/시각·소유 PID/입력0 훼손·누락/중복 표시 이력·공용 설정 변경·복구시각 역전·원문/manifest/승인 hash변경은 거절.
- 기존4~10회/v2·서명/산출물·한 Cloud·만료/168시간·공개 거절 전체 회귀와 package/diff 검사를 수행.
- 실제94개 원문과 보정 집계를 전체 함수에 넣었을 때 미실행인 reviewed-main/실제 Cloud run gate2개 외 이력 오류가 없어야 한다. 이를 전체 중앙 통과라고 쓰지 않는다.
- 최종 코드/등록 diff5파일만 Claude Code 읽기 전용으로 전송한다: bootstrap검증기, bootstrap합성 테스트, provider합성 테스트, 해당 grantJSON, development-workflow.yaml의 registry추가. 자격증명·개인정보·PixelLab 원본·승인 원문·실행 로그·관찰 원문은 제외하고 도구/MCP접근을 차단한다. 자동 Copilot을 포함해 PR당 총2회 이내. 병합은 검사·리뷰 지적 처리·미해결 thread0 뒤 수행한다.

## 유지하는 출시 순서·중단·제거

첫 내부1.1.0 한 Cloud/정확 production서명 산출물 gate→VALID/INTERNAL_ONLY/그룹→실제 iPhone설치·필수 검수→앱 예외 인자 제거→새1.1.1/정상v2/L3·E2E·양대 필수 실기기/UI→심사·승인·글로벌 공개·설치/업데이트 실행 확인을 유지한다. 사용자 TestFlight확인은 선택이다. 새로운 UI회차나 기한 연장·검수 면제·추가 Cloud 시도를 허가하지 않는다.

실제 서명/프로필/산출물 불일치면 승인된 한 시도를 소비하고 중단한다. 실패 때 태그를 옮기거나 원문을 고치지 않는다. 이 보정의 사용 범위는 같은 첫 내부1건과 원래 기한이며 v1종료 뒤 제거한다.
