# Cloud12 실패 보존과 첫 내부 TestFlight 한 회 추가 실행안

상태: 승인 전 제안. 추가 Cloud 생성·중앙 제품 코드 변경·새 Claude 전송은 하지 않았다.

## 현재 확인 결과

- 중앙 PR263은 b1353afe152a72c3d609bd03bb9486182cf58106으로 병합됐고 CI가 통과했다.
- 공식 내부 v1.1.0/source dc7ebea858def2a34a7732f6c144ef4e60fb34d3의 Cloud12(run bc1bd2ba-743e-4db2-a3a8-00cb10ba1203)는 2026-10-16T06:22:03.296Z에 FAILED로 끝났다. 승인한 Cloud1회가 소진됐다. 임의 재시작은 없다.
- 실제 실패 위치는 ci_post_clone의 before-build, TESTFLIGHT_CI_CONTEXT다. 실제 같은 실행의 환경 로그에서 CI_TEAM_ID가 App Store Connect 계정 UUID인 69a6de86-a179-47e3-e053-5b8c7c11a4d1임을 확인했다. 코드가 이를 앱 서명팀 HCDUXX4Z3X와 비교했다. 다른 공개 CI값9개는 일치했다.
- 실제 provider 재조회에서 build12에 연결된 배포 빌드0, artifact는 LOG_BUNDLE 한 개, 앱의 업로드 build12 없음이다. archive·서명·업로드·TestFlight 도달은 없다.
- 실제값으로 그 조건만 바꾼 임시 재현 검사는 변경 전 실패/변경 후35건 모두 통과했다. tracked 코드는 아직 바꾸지 않았다.
- Apple 화면에서 확인한 다음 번호는13이다. 번호를 바꾸거나 할당하지 않았다.

## 승인 요청 범위와 변경 후 흐름

실패12 기록 보존 → 중앙 조건·명시적 한 회 복구 허용 보정 → Ready PR/필수 검사/제한 교차 리뷰/병합 → 같은 dc7/v1.1.0의 수동 태그 Cloud13 한 번 → 실제 production 서명 산출물 검증 → 내부 TestFlight 처리·그룹 도달 → 실제 iPhone 검수 → 예외 인자 제거 → 새1.1.1 정상v2/L3·필수 실기기/전체 E2E → 양대 심사·승인·글로벌 공개·스토어 설치 실행 확인.

1. Cloud 계정 UUID 비교만 실제 namespace에 맞춘다. 앱 서명팀 HCDUXX4Z3X·기존 인증서·기존 profile·8개 숨김 변수·앱 소스·태그는 유지한다.
2. 원래 Cloud1회 한도에 **한 회만 추가**해 이 첫 내부 후보의 전체 Cloud 한도를2로 명시한다. 기존 실패12를 지우거나 계수에서 숨기지 않는다. 전체 업로드 한도는1이다. 번호13은 재조회한 실제 다음 번호가 그대로13일 때만 생성한다. 다른 번호면 자동 변경하지 않고 중단한다.
3. 기존 검증기에 명시적인 단일 복구 허용을 추가한다. 기본 동작은 기존1실행만 허용하고, 새 사람 승인·proposal 해시·현재 중앙 main의 승인 grant가 일치할 때만 다음을 허용한다.
   - 과거 실행은 위 run12/number12/source/workflow/product가 정확히 일치하고 provider가 실제 FAILED·종료 시각·연결 빌드0·archive 산출물 없음으로 확인해야 한다.
   - 과거 실패 로그의 승인한 SHA256과 실제 provider 로그 자산 bytes를 대조한다. 로그 ZIP SHA256은 1bd18f3dfa3fcb134ddf00945b730a1f79ba64a22c1e5e6bd0e7520311777ed2다. raw 로그/화면을 공개 중앙 repo나 Claude에 보내지 않는다.
   - 같은 source의 전체 실행은 실패12와 새 수동 태그13의 정확한2개뿐이다. 실패 실행을 일반적으로 무시하는 필터를 만들지 않는다. 제3실행·다른 실패·다른 source·다른 workflow·다른 번호·로그 변조·기존 업로드가 있으면 거절한다.
   - before-build와 before-deploy는 같은 새 run13/number13/승인 grant에 결속한다. receipt에도 과거 실패/전체 Cloud2/업로드1 상한을 드러낸다.
4. build13의 unsigned project-only 두 경로에서 동일한 생성 bytes를 확인한 project.godot와 project.pbxproj 해시 두 개만 before-deploy grant에 반영한다. actual archive·서명 검증은 실제 Cloud artifact 생성 뒤 유지한다.
5. 필수 검사·리뷰·지적 처리 뒤 중앙 PR을 병합한다. 실패 상태·원래 승인 시각·원래 만료2026-10-20T23:16:52.580641Z(10월21일08:16:52KST)·원문94개·Android 근거·iPhone/E2E/public 조건을 유지한다. 새 UI회차·기한 연장·QA 면제는 없다.

## 구현 파일과 리뷰 전송

중앙 코드·설정·합성 테스트 변경은 아래7파일로 제한한다. 승인·설계·실행 문서는 docs/design/2026-10-16-spiritgate-cloud12-recovery에 별도로 기록하고 Claude 전송에서 제외한다.

- contracts/development-workflow.yaml — 기존1회 기본값과 별도 명시 승인 단일 복구 정책
- contracts/development-workflow.schema.json — 위 정책의 엄격한 형식
- contracts/internal-testflight-bootstrap-grant.schema.json — 정확한 이전 실패·새 승인·추가1회 상한 형식
- contracts/internal-testflight-bootstrap/spiritgate-1.1.0-first-internal.json — 사람 승인 해시·정확한 실패12·예상13·두 생성파일 해시
- scripts/release/internal-testflight-bootstrap.mjs — 실제 CI 계정 ID, 승인·이력·provider·동일 receipt 검증
- tests/internal-testflight-bootstrap-provider.test.mjs — HTTP/CI namespace/실패12와 새13/제3회 거절 합성 검사
- tests/internal-testflight-bootstrap.test.mjs — grant/승인/원래 만료·receipt·public 금지 회귀

새 PR의 최종 위7파일 코드 diff만 Claude Code 읽기 전용 검토로 전송한다. 도구/MCP 접근0, 자격증명·개인정보·PixelLab 원본·승인 원문·실행 로그·관찰 원문·실제 화면은 제외한다. 자동 Copilot이 실행되면1회로 계산하며 Claude1회와 합해 총2회 상한이다. 추가 과금·키/인증서/profile 생성은 없다.

## 테스트 계획과 인수조건

- 중앙 변경은 L1/개발 서비스 환경에서 작성자가 실행한다. 앱 공개1.1.1은 기존 L3/양대 마켓/public 계획을 유지한다.
- TDD: 실제 CI_TEAM_ID를 사용한 기존 실패를 재현했고 한 조건 보정 시35건을 통과했다. 이후 단일 복구 승인·정확한 이전 실패·실제 현재 실행·전후 receipt·기존1회 기본 동작의 통과/거절 시나리오를 먼저 추가한다.
- 거절: 승인 누락/다른 해시/현재 main의 revoke/만료/다른 run12/source/workflow/product/성공·진행 중 과거 실행/기존 archive·연결 빌드/로그 hash 불일치/3실행/다른 새 번호/실패 상태 세탁/공개용 phase/잘못된 namespace.
- 중앙 전체 테스트·pack·actionlint·diff와 Ready PR CI, 실제 리뷰 지적 처리·미해결0을 확인한다.
- 병합 뒤 실제 최신 main의 코드/승인/grant bytes, 고정 앱3142파일·태그·설정·현재 provider 상태·현재 다음13을 재조회한다. 격리 unsigned 재현은 실제 production 서명/업로드 PASS가 아니다.
- Cloud13 생성은 배타적 한 번 marker와 공급자 응답으로 기록한다. 실패하면 재시작하거나14번을 만들지 않는다. TestFlight 실제 VALID·내부 그룹 배포가 확인돼야 첫 내부 완료로 기록한다.

## 운영·복구와 영향

이 제안을 거절하면 기존 한도가 소진돼 첫 내부 TestFlight는 중단 상태를 유지한다. 승인하면 실패12를 남긴 채13 한 번을 진행한다. 새 오류가 나면 같은 한도 안의 소스 변경이나 추가 Cloud로 우회하지 않는다. 현재 공개판은 변경하지 않았다.

제품 UI·세계관·사용자 데이터 구조·전투 규칙 변경은 해당 없음(릴리스 검증기만 보정). 새 Apple 리소스와 민감 변수 전송도 해당 없음(기존 자원 유지). 직접 물리 작업은 현재 요청하지 않는다.

## 승인 전 생성파일 재현 결과

2026-10-16T06:53:01Z까지 서로 다른 d/c 경로에서 순차 완료한 unsigned project-only 두 결과를 대조했다. 원래3142파일 확인, 변경 파일 정확히2개, Godot 오류0, 생성 해시 동일이다. 실제 서명/Cloud/업로드는0이다. 최초 샌드박스 차단과 공유 엔진 임시파일 병렬 충돌 실패는 원문에 남기고 근거로 사용하지 않았다.

- `project.godot`: `2a5633b0c4ed15e154cec2918e512fd4acb5ea7d46ded03190eed1c94e96af3b`
- `xcode-cloud/SpiritgateDefenders.xcodeproj/project.pbxproj`: `24052024e19f5d3498bfd15ba860a621a05ecfb94b6090eb5bc9ae73d19ec52f`

현재 repo 코드 변경/새 PR/새 Claude 전송/추가 Cloud 생성은0이다. 이 문서의 명시 승인 전 해당 작업을 시작하지 않는다.
