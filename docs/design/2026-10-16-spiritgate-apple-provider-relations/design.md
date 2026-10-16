# 첫 내부 Apple 관계 조회 보정

상태: 사용자 승인 후 최소 구현·회귀 완료, PR263 최종 CI/병합 대기. [approved-proposal.md](approved-proposal.md)는 승인 전 시점의 불변 원문이며 그 문서의 승인 대기 표기는 현재 상태가 아니다. 현재 승인은 [approval.json](approval.json), 정확한 계획은 [test-plan.json](test-plan.json), 결과는 [execution.md](execution.md)다. 원문의 해시를 보존하기 위해 승인 전 문장을 소급 수정하지 않는다.

## 목적·범위·근거

실제 Apple 기본 GET 응답은 관계 data를 생략한다. product/app, workflow/product 및 run/workflow·product·sourceBranchOrTag를 include로 명시해 기존 엄격한 검증기에 실제 필수 정보를 전달한다. 사용자 화면·입력 흐름·아트는 해당 없음: 서버 상태를 읽는 검증기만 바꾼다. 제품 저장·마이그레이션도 해당 없음: source/grant/원문을 변경하지 않는다.

## 흐름·구조·실패 처리

기존 bootstrapProvider의 HTTP 조회→실제 관계 data→기존 app/product/workflow/tag/run 일치 판정을 유지한다. 데이터 형식과 책임 분리는 그대로다. 필수 관계가 반환되지 않거나 다른 앱/후보/run이면 추정·대체 없이 기존 오류로 거절한다. 새 schema·의존성·credential·서명·기한·권한은 추가하지 않는다.

## 품질·대안·인수조건

관계 검사를 생략하는 대안은 채택하지 않는다. 공식 include 옵션은 요청한 실제 데이터를 받으면서 기존 엄격한 판정을 유지한다. 기준은 [실행 티켓](execution-ticket.md)의 RED→GREEN·누락5종 거절·전체 회귀·pack/actionlint/diff·CI·제한 리뷰다. L1/dev이며 제품 실행 검수는 해당 없음: 코드/합성 transport 검증과 실제 read-only 관측을 구분한다. 정확한 runtime 코드2파일만 Claude에 보내고 실제 관측·승인 원문·개인정보·credential·실행 로그를 제외한다.

## 적용·운영·복구·추적

중앙 PR263의 필수 검사·지적 처리·미해결0 뒤 병합하고 기존 Cloud 연결부가 실제 reviewed main을 읽도록 한다. 실패하면 Cloud를 시작하지 않고 원문을 보존한다. 복구가 필요하면 중앙 PR로 코드/등록을 재검토하며 임의 추가 빌드·태그 변경·서명 교체로 우회하지 않는다.

고정 dc7/v1.1.0·원래 한 Cloud/업로드·만료·production 서명·iPhone·공개 v2/L3/E2E는 불변이다. 실제 Cloud 두 단계/산출물 검사는 후속 실행이며 합성 통과를 해당 근거로 쓰지 않는다.
