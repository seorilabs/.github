# UI와 서비스 실행이 함께 있는 개발 근거

- 상태: 승인 대기, 구현하지 않음
- 기준: `8a1410b4ae7352caed15d6431992d774bd3c96b6`
- 영향 저장소: `seorilabs/.github`, `seorilabs/happy-farm`
- 접수: Happy Farm [#478](https://github.com/seorilabs/happy-farm/issues/478), [#483](https://github.com/seorilabs/happy-farm/issues/483)
- 테스트 계획: [test-plan.json](test-plan.json)

## 문제와 목적

Happy Farm PR [#585](https://github.com/seorilabs/happy-farm/pull/585)와 [#586](https://github.com/seorilabs/happy-farm/pull/586)은 실제 게임 UI 전체와 배포 감시 서비스 런타임을 각각 검수했다. 현재 근거의 `productKind`는 `ui` 또는 `service` 하나뿐이다. UI를 선택하면 서비스 실행이 `UI_RUNTIME_REQUIRED`로, 서비스를 선택하면 브라우저 실행이 `SERVICE_RUNTIME_REQUIRED`로 차단된다. 서비스 실행을 브라우저로 바꾸어 기록하거나 기능을 목록에서 빼지 않는다.

## 변경 계약과 책임

`contracts/development-evidence.schema.json`에 `productKind: "mixed"`를 추가하고, 기능 목록 schema의 기능별 선택 필드 `runtimeKind: "ui" | "service"`를 추가한다. 기존 ui/service 문서와 기능 목록의 의미는 보존한다. mixed 문서에서만 누락된 runtimeKind는 ui이며, 실제 서비스 기능은 명시적으로 service를 선언해야 한다.

검증기는 mixed 문서에서 실행 종류와 기능을 함께 대조한다. service-runtime은 service 기능만 충족하고, 브라우저와 Editor 등 UI 실행은 ui 기능만 충족한다. 서로 다른 종류의 실행으로 부족한 기능을 충족시킬 수 없다. 양쪽 종류의 기능과 실제 실행을 모두 요구하며, 알 수 없는 기능과 잘못된 분류는 거절한다. 동일 후보, 독립 실행, 168시간, 승인 계획, 하한과 오류 및 복구 검사는 유지한다.

UI 개편이면 UI 기능 전체의 독립 검수 3회가 필요하다. 서비스 기능은 별도의 실제 서비스 실행으로 검수하고 UI 회차의 완료로 대체하지 않는다. 기존 ui/service 문서의 동작과 과거 예외 계약은 바꾸지 않는다.

구현 범위는 기능 목록 및 개발 근거 schema, `scripts/release/verify-development-evidence.mjs`, 관련 단위 테스트와 실행 문서다. Happy Farm에서는 두 감시 PR의 기능 목록에 service 분류만 추가하고 최신 main과 통합한 새 후보에서 전체 개발 검수를 다시 수행한다. 감시 제품 동작과 승인된 테스트 계획은 바꾸지 않는다.

## 인수조건과 검증

1. 기존 ui와 service의 통과 및 실패 fixture 결과가 그대로다.
2. 같은 후보의 UI 전체와 서비스 실행을 갖춘 mixed fixture만 통과한다.
3. service 실행으로 UI 기능을, UI 실행으로 service 기능을 충족시키면 실패한다. 한쪽 실행 누락, 알 수 없는 기능, 후보 불일치, 만료, L3 자기 실행도 실패한다.
4. mixed UI 개편에서도 UI 전체 검수 3회와 서비스 검수 조건이 모두 유지된다.
5. 중앙 전체 테스트와 schema 검사를 통과한 뒤 별도 PR로 squash 병합한다. 이후 Happy Farm #585, #586은 각각 새 후보 검수와 중앙 검사 및 CI를 통과해야 병합한다.

TDD는 기존 계약의 mixed fixture 실패를 먼저 보존하고 최소 구현 뒤 경계 fixture와 전체 회귀를 실행한다. 중앙은 L1 dev이며 제품 UI 변경은 없다. Happy Farm의 기존 L3 개발 검수 하한을 줄이지 않는다.

## 승인 범위와 복구

승인 요청은 위 중앙 계약 보완과 두 Happy Farm PR의 개발 검수 및 병합까지다. 배포, 업로드, 심사, 운영 설정과 기기는 제외한다. 실패한 기존 근거와 NAS 원본은 보존한다. 문제가 생기면 새 mixed 문서의 병합을 중지하고 기존 ui/service 경로를 유지한다. 추가 마켓 예외나 검사 생략은 만들지 않는다.
