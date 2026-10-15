# 정상 v2의 추가 UI 회차별 승인 보존 — 읽기 전용 진단·최소 설계안

상태: **미승인 제안**. 구현·PR·외부 리뷰·실제 grant·번호·태그·빌드는0이다. 제품 UI7은 별도 실행자가 계속 검수한다. 이 디렉터리의 fixture/result는 실제 제품 QA 결과가 아니다.

## 확인한 문제와 재현

최신 중앙 main을 다시 fetch해 `20aae2bfb0923a464e6fe7d36e7c797c8019b34c`를 확인했다. 기존 작업 공간의 관련 파일 bytes가 그 main과 같음을 검사한 뒤 공개 함수 `validateDevelopmentEvidence`와 기존 `tests/helpers/test-levels-fixture.mjs`를 직접 import했다. `checkReviewRounds`를 복사해 가짜 검증기를 만들지 않았다.

```bash
node /private/tmp/sgd-normal-v2-round-approvals-20261015/reproduce.mjs
```

| 순수 fixture 입력 | 현재 공개 validator의 결과 |
|---|---|
| 기존 L3 재설계4회 + 회차 전 단일 max4 승인 | ok:true |
| 같은4회에 승인 없음 | EXTRA_ROUND_APPROVAL_REQUIRED |
| UI4–7 이력 + 실제 최신 UI7 승인 시각/max7 한 개 | EXTRA_ROUND_APPROVAL_REQUIRED |
| UI4–7 이력 + 실제 UI4 승인 시각/max4 한 개 | EXTRA_ROUND_APPROVAL_REQUIRED |
| 실제4–7 시각/한도를 각각 담은 plural + single:null | EVIDENCE_SCHEMA /: additionalProperties |

입력 문서·context·결과를 case별 JSON으로 보존했고 `results.json`에는 검증기/schema/helper 파일 SHA256와 중앙 SHA를 남겼다. 실행·통과 관찰은 모두 가상 fixture이며, 사람 승인 시각/한도 사실만 중앙 원문에서 읽었다. 과거 실패는 fixture에서도 resolutionEvidence와 함께 유지했다.

실제 승인 사실은 다음과 같으며 이를 합성한 ‘예전 시각/max7’ 단일 승인을 만들면 안 된다. 각 raw timestamp의 끝 +00:00만 Z로 옮기며 fraction은 보존한다.

| 회차 | 원래 승인 시각 | 한도 |
|---|---|---:|
| UI4 | 2026-10-13T23:16:52.580641+00:00 | 4 |
| UI5 | 2026-10-14T10:56:24.262911+00:00 | 5 |
| UI6 | 2026-10-14T22:39:56Z | 6 |
| UI7 | 2026-10-15T09:24:12.777309+00:00 | 7 |

## 실제 코드·소비자 경계

- `scripts/release/verify-development-evidence.mjs:60–62`: v2는 single 하나를 모든 추가 회차에 적용한다. 뒤의 실제 승인은 과거 계획보다 늦고, 예전 실제 승인 max4는 뒤 회차를 승인하지 않는다.
- `contracts/development-evidence.schema.json:18,219–254`: single은 필수 nullable object이고 추가 필드는 금지한다. plural은 정의되어 있지 않다.
- `scripts/release/development-evidence-v1.mjs:68–69`와 v1 schema: v1은 이미 single+plural을 배열로 합쳐 검사한다. #254의 UI7 보정은 이 v1/bootstrap 경로에 속하며 정상 v2 문제를 해결하지 않는다.
- 중앙의 직접 소비자는 위 v1/v2 validator, bootstrap, 각 단위 fixture/test, 예제 문서다. normal v2의 직접 단일 승인 테스트는 `tests/test-levels.test.mjs:160–167`이다. `consumer-search.json`에 전체 검색 명령과44개 중앙 참조를 보존했다.
- Spiritgate primary 및 운영 원장 checkout, Backoffice의 로컬 추적 대상 JS/TS/MJS/JSON/SH/PY/MD에서 두 필드의 직접 참조는0개였다. Spiritgate `xcode-cloud/ci_scripts/development_evidence.sh`는 중앙 정확 SHA를 내려받아 CLI에 근거를 전달하며 승인 객체를 직접 해석하지 않는다.
- 모든 조직 저장소/원격·gitignored 생성물을 전수 조사한 것은 아니다. 외부 소비자가 없다고 단정하지 않는다. 기존 유효 wire format과 schemaVersion2를 유지하는 추가 필드 방식이 호환 위험을 줄인다.

## 대안 비교와 제안

| 대안 | 호환·모호성 | 판단 |
|---|---|---|
| 기존 single 타입을 array/union으로 바꿈 | 같은 필드 의미가 달라지고 기존 object 소비자 대응이 필요함 | 제외 |
| optional plural 추가, single과 모두 합쳐 v1처럼 사용 | 기존 입력 유지. UI4 single+UI5–7 plural을 그대로 표현하지만 두 채널의 같은 한도/시각 충돌 규칙이 추가로 필요함 | 가능한 대안 |
| optional plural 추가, plural이 있으면 single은 명시적으로 null | 기존 single 전부 유지. 새 입력만 명확한 한 채널로 사용하며 충돌을 schema에서 거절 가능 | **추천** |

추천안의 타입은 `additionalIterationApprovals?: Approval[]`다. Approval은 기존 `additionalIterationApproval`의 object arm을 그대로 참조한다. approverKind/approver/approvedAt/maxRound/evidence 타입과 추가 키 금지를 바꾸지 않는다. 배열은 비어 있으면 거절한다. single은 현재처럼 필수 nullable 필드로 남긴다. plural이 있을 때 single이 non-null이면 거절한다. 이 제한은 이전에 허용되지 않던 새 plural 입력에만 적용하므로 기존 유효 입력은 바뀌지 않는다.

새 plural 내 동일 maxRound의 중복·서로 다른 시각/근거 충돌은 조용히 덮어쓰거나 최신 것을 고르지 않고 거절하는 안을 제안한다. 입력 배열 순서에는 의존하지 않는다. 각 추가 회차는 실제 기록의 승인 중 `maxRound >= round.number`, 유효한 승인 시각, `approvedAt <= round.plannedAt`를 만족하는 원문을 찾아야 한다. **maxRound의 기존 상한 의미를 exact-round 의미로 바꾸지 않는다.** 기존에 한 번의 진짜 사전 승인이 여러 회차를 허용한 single 동작도 유지한다. 서로 다른 상한의 유효 승인이 같은 회차를 정당하게 허용하는 것은 권한을 새로 합성하는 일이 아니며, 원문 시각/한도를 바꾸어 하나의 가짜 승인을 만들지 않는다.

UI4–7은 새 plural 한 배열에 실제 네 원문을 각각 투영하고 single:null을 쓴다. 기존 v1 JSON과 승인 원문은 수정하지 않고 별도 보존한다. 현재 generic v2 verifier는 evidence 문자열이 가리키는 사람 승인 문서 bytes를 직접 읽거나 hash 검증하지 않는다. 이 제안은 표현과 기존 시간/한도 판단만 보정하며 새로운 승인 trust 검증을 했다고 주장하지 않는다.

## 필수 변경 파일과 최소 검사

구현 승인 후 필요한 최소 파일은 다음4개다.

1. `contracts/development-evidence.schema.json`: optional plural과 기존 Approval 타입 참조, single 동시 사용 금지.
2. `scripts/release/verify-development-evidence.mjs`: v2의 승인 입력 모드·중복/충돌 거절과 각 회차의 기존 사전 승인 조건 검사.
3. `tests/test-levels.test.mjs`: 실제 공개 함수 기반 회귀.
4. `docs/agent-governance/development-workflow.md`: 정상 v2의 두 입력 방식·원문 보존·실패 시 처리 설명. 예제 변경이 필요하면 기존 single:null 예제를 유지하고 별도 plural 예시만 추가한다.

v1 schema/validator, bootstrap/grant schema·registry, workflow·서명·시장·제품 소스는 수정하지 않는 안이다. 실행 티켓은 기존 Spiritgate #240과 새 중앙 설계/승인 기록을 연결한다. 중앙 변경만 L1/dev로 검증하며 실제 제품의 L3 계획은 그대로다.

최소 TDD/회귀:

- 기존 single3/4회 허용·누락·늦은 승인·maxRound 부족 동작 유지.
- 현재 재현한 진실한4–7 plural이 schema에서 거절되는 RED → 최소 구현 GREEN.
- UI4/5/6/7 각각 누락, 각 계획 뒤 승인, 부족한 한도 거절. 최신 승인 하나가 과거 회차를 소급 승인하지 못함을 확인.
- single non-null+plural, 빈 배열, null/object 대신 잘못된 원소, 같은 maxRound 중복/충돌 거절. 배열 순서만 바뀌면 동일 판정.
- 과거 실패+실제 해결 근거 유지, 해결 근거 누락·최종 기능/UX 실패·ROUND_OVERLAP·독립성·전체 범위 검사 유지.
- 기존 L3 하한·첫 출시 하향 금지·실제 run 168시간·before-build/before-release 요구·마켓 스코프 검사 회귀 유지.
- 기존 v1 single+plural 및 첫 내부 UI4–7/bootstrap 전체 검사 유지. 전체 npm test, pack:check, actionlint, diff 검사.

## 변하지 않는 조건과 실행 순서

정상 v2에는 원래부터 generic 회차별210분이나 첫 내부 grant expiry 필드가 없다. 이 보정을 그 조건의 면제나 새 enforcement라고 주장하지 않는다. 원래 회차별180+단1회30/210분과 실패 원문은 승인 설계/실제 보고서와 기존 bootstrap 검증에서 그대로 보존하며, 최초 내부 만료2026-10-20T23:16:52.580641Z·v1 종료2026-10-22T00:00Z·한 후보/한 빌드/한 업로드는 변경하지 않는다.

구현 승인 → 별도 feature/Ready PR → 필수 검사·정책상 필요한 별도 제한 교차 리뷰 승인 → 새 중앙 SHA 확정 → 원문 승인 체인을 투영한 실제 정상v2 근거 작성 → 해당 SHA 검증 순서다. 이전 중앙 SHA는 새 plural을 거절하며 이를 우회하려고 단일 가짜 승인을 만들지 않는다. 현재 #254는 리뷰2/2로 끝났고 다시 열거나 3차 리뷰를 붙이지 않는다. 이번 진단은 새 Claude 전송 권한을 만들지 않는다.
