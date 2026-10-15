# UI8 중앙 검증기 구현 확인

- RED: 기존 schema에서 신규8회 합성 정상 입력은 `TESTFLIGHT_BOOTSTRAP_REQUIRED`. 관련328검사 중322통과/6실패(정상8회와 예산 guard 도달 검사)로 실패를 먼저 보존했다.
- GREEN: 최소 schema/verifier 및 공격 입력 회귀 후 초기 관련384검사/전체905검사 통과. 리뷰 보정 후 관련399검사 통과, 전체 `npm test`920검사 통과, `npm run pack:check`, `actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml`, `git diff --check` 통과.
- 최초 전체 검사는 기존 HTTP fixture의 sandbox `listen EPERM 127.0.0.1` 한 건으로897/898이었다. 같은 검사를 허용된 실행 환경에서 다시905/905 확인하고 리뷰 보정 후920/920 확인했으며 이 환경 실패를 제품 실패나 통과로 바꾸지 않았다.
- 실제 UI7 원본12종의 형식/의미가 새 역사 검증에 맞는지 별도 읽기 전용 입력 대조를 수행했다. 전체 입력은 의도적으로 유효하지 않은 합성 후보였고, 실제 제품 QA·실제 grant 검증 통과가 아니다. 원본 내용/실행 로그는 중앙 코드·외부 리뷰에 넣지 않았다.
- 기존 UI5/6/7 승인·제안 bytes와4~7 경로·기한·예산·정상 v2를 보존했다. registry는[]이며 실제 UI8 진단은 차단, 제품 Run·후속 전체 E2E·Android·iPhone·Cloud 산출물·마켓 공개는 완료하지 않았다.
- 실제 Run 전 고정된 source/QA지문은 승인 결속에 남겼지만 native market 실행 근거로 사용하지 않는다. 실제 grant 등록은 별도 근거와 검토가 필요하다.

한글 Ready PR 최종 HEAD의 제한 코드 diff만 리뷰한다. 자동 Copilot 포함 요청2회 상한, 지적별 처리·필수 검사·미해결 thread0·충돌 없음 확인 후 병합한다. 리뷰 결과와 최종 SHA는 PR 원문 댓글/병합 영수증을 정본으로 삼는다.

리뷰 대상 HEAD는 cf33ab0이다. Copilot Lite1회와 Claude 코드만1회로 요청2회를 소진했다. 출처 hash 상호 대조·UI7 manifest 이후 UI8 승인·원래 cap 안 manifest·정확 Run marker PID 종료의 실제 공격 입력을 RED387중3실패 및 RED399중1실패로 보존하고 최소 보정해 GREEN399를 확인했다. 공개/비공개 승인 영수증 bytes는 바꾸지 않았다. 보정 최종 HEAD는 추가 외부 리뷰를 받지 않았으며 최종 자체 검증/CI와 지적별 처리로 판단한다.
