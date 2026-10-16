# 첫 내부 TestFlight Apple 관계 조회 최소 보정

상태: 별도 승인 대기. 제품·중앙 tracked 코드 미변경, Cloud/업로드0. #262는 c078a9a18de848e5f0e834e04bfa2fac4f3a6ede로 병합됐고 기존 workflow의 예외 ID/설정 지문2개는 실제 저장·재조회했다.

## 확인한 결함

실제 GET /v1/ciProducts/{id}는 include 없이 relationships.app.data를 반환하지 않고 links만 준다. GET /v1/ciWorkflows/{id} 역시 include 없이 product 관계가 없다. 현재 bootstrapProvider는 이 데이터가 항상 있다고 가정하므로 TESTFLIGHT_APPLE_PRODUCT에서 차단된다. Apple 공식 OpenAPI4.5.1의 include 허용값과 실제 include=app/product 응답을 대조했다. 앱/계정/권한의 문제가 아니며 테스트 fixture가 확장된 관계만 제공했던 검증기 결함이다.

실제 run0·INTERNAL_ONLY·수동 태그 전용·dc7/v1.1.0/1000015 불변·build12 미업로드·원래 기한 내는 추가 읽기 전용 확인을 마쳤다. run을 만들지 않아 실제 CI 증거는 없다.

## 보정 범위

- scripts/release/internal-testflight-bootstrap.mjs: product?include=app, workflow?include=product, ciBuildRun?include=workflow,product,sourceBranchOrTag 세 요청 옵션만 추가한다. 기존 bootstrapProvider를 export해 같은 HTTP 호출 경로를 합성 transport 테스트에서 검증한다. 판정·허용 상태·서명·grant·증거·기한은 변경하지 않는다.
- tests/internal-testflight-bootstrap-provider.test.mjs: include 없으면 실제와 같이 links만 반환하는 HTTP 모의 경로와 필수 관계5개 누락 거절을 추가한다. 테스트 키는 메모리에서 생성한 합성 EC키이고 외부·파일에 저장하지 않는다.
- 설계·테스트 계획·실행 기록은 별도 docs에 둔다. 승인 전 patch/proof만 준비했고 tracked 구현·PR·외부 리뷰는 하지 않았다.

구체적인 2파일 patch: /private/tmp/sgd-provider-query-proposal-20261016/proposed.patch
patch SHA256: 99d2cd9e32029e9b9c72417898187c87908a26746c5c2f6b9615bf9b9e6505cf (4836 bytes)
RED: 새6건 중5PASS/1FAIL, 기존 reader의 TESTFLIGHT_APPLE_PRODUCT 재현.
GREEN: 최소 보정 임시 모듈에서6/6PASS. 실제 Cloud 또는 기기 PASS가 아니다.

## 승인 뒤 실행

중앙 최신main에서 feature/ 별도 공간을 사용해 patch를 적용하고 L1/dev의 전체 npm test·pack·actionlint·diff를 실행한다. 한국어 Ready PR을 만들고 최종 위 코드2파일 diff만 Claude Code 읽기 전용(tools0/MCP0)에 전송한다. 자격증명·개인정보·PixelLab 원본·승인 원문·실행 로그·관찰자료는 전송하지 않는다. 자동 Copilot 포함 총2회 상한, 지적 처리·필수 검사·미해결thread0 뒤 병합한다.

같은 고정 dc7/v1.1.0 후보·실제 다음12·INTERNAL_ONLY/run0·기존 생산 서명·단한 Cloud/업로드·원래2026-10-20T23:16:52.580641Z 만료를 유지한다. 다시 조회 후 기존 workflow의 공식1빌드를 시작하고 before-build/before-deploy는 새 reviewed main의 정상 bootstrap 검사를 실제 Cloud에서 실행한다. 공개 v2/L3·양대 실기기·E2E·UI·1.1.1 조건은 유지한다. 새 키/인증서/profile/권한/회차/기한 연장/추가 Cloud를 허용하지 않는다.

승인을 요청하는 근거: seorilabs-release-run/SKILL.md의 “파이프라인을 고쳐야 릴리스가 되는 상황이면 고치지 말고 멈춰서 정확한 blocker를 보고한다.” 기존 #262 승인은 실패 UI6 이력 최소 보정과 해당 PR의 지정5파일 전송으로 한정되어, 새 공급자 조회 결함의 별도 PR·제한 전송은 추가 범위다.
