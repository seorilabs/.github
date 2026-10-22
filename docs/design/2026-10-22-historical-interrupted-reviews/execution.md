# 중앙 과거 중단 기록 검증

기준은 최신 원격 main `246e9c7ded7e8ab8416e26318464228142cd4100`, 이슈는 #300, 실행 환경은 L1 dev다. 앱 실행, 기기 사용과 마켓 변경은 하지 않았다. 사용자 작업과 기존 verifier checkout을 보존하고 별도 worktree를 사용했다.

## 요구 실패와 구현 결과

신규 계약 검사59개를 구현 전에 실행했을 때54개가 통과하고 새로 허용할 유효 입력5개가 `EVIDENCE_SCHEMA /reviewHistoryRecovery: additionalProperties`로 실패했다. 구문이나 환경 오류가 아니다. 원본 red 로그를 보존했고 별도 재확인 실행의 exit1도 기록했다. 선택 `interruptedRounds`와 검증기 구현 후 신규59개,기존 현재 중단과 결손 복구를 합친124개가 통과했다.

전체 첫 실행은1795개 중1792개 통과와3개 실패였다. 이3개는 실제 시계를 사용하던 기존 v1 CLI fixture가2026-10-22T00:00:00Z의 기존 만료 조건에 걸린 것으로, 변경 없는 clean246 checkout에서도 동일하게 재현했다. 운영 만료와 기본 시계는 유지했다. 테스트 자식 프로세스에서만 `node:test`의 Date mock을 명시적으로 preload하고 역사적 fixture 시각을 사용하도록 고쳤다. 만료 시각을 넣은 실제 CLI는 `EVIDENCE_V1_RETIRED`로 exit1이며 기존 성공 receipt를 덮어쓰지 않는 단언도 통과했다. 근거 API는 [Node24 Date mock 문서](https://nodejs.org/docs/latest-v24.x/api/test.html#dates)다.

- 신규 과거 중단 검사:59개 통과.
- 관련 계약 검사:124개 통과.
- 기존 CLI 검사와 만료 거절:28개 통과.
- 최종 `npm test`:1795개 통과,실패0,skip0.
- `npm run pack:check`:통과.
- `actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml`:통과.
- 테스트 계획 스키마 및 `git diff --check`:통과.

테스트는 합성 계약 fixture와 자신의 임시 저장소만 사용한다. 원래 제품 보고서와 사용자 승인을 검사 결과로 만들어 내지 않았다. 첫 red,전체 첫 실패와 기준 checkout 재현,green 로그는 저장소 밖 실행 원장에 각각 보존했다.

## 독립 검토와 후속 단계

구현자와 다른 검토자가 핵심 계약,검증기와 신규59검사를 읽고 수정이 필요한 결함을 발견하지 못했다. 역사 시계의 테스트 보완은 별도 delta로 독립 검토한다. 최종 HEAD의 로컬 MiniMax 리뷰와 Ready PR의 실제 CI,미해결 thread0과 권한 및 정상 squash 확인은 PR 진행 기록으로 남긴다. 이 문서는 아직 PR 병합이나 제품 출시를 완료했다고 선언하지 않는다.
