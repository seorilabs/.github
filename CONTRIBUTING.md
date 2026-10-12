# Seorilabs Contribution Guidelines

Seorilabs repo에 기여하는 사람과 agent는 같은 운영 계약을 따른다. repo-local 지침은 stack과 앱 고유 사항을 추가하지만 `contracts/`의 조직 계약을 약화하거나 다른 의미로 덮어쓰지 않는다.

## 기본 원칙

- 장기 작업은 GitHub Issue 또는 Project item 없이 시작하지 않는다.
- PR은 연결 티켓, scope, 검증 결과, spec/version impact를 포함한다.
- 기획 승인 전에는 신규 app code, repo scaffold, store registration을 만들지 않는다.
- 배포 승인 전에는 production submit, track promotion, public release를 하지 않는다.
- 제품 기획·의사결정은 Obsidian/Vault, 조직 공통 엔지니어링 계약은 이 저장소의 `contracts/`, 앱별 사실은 해당 repo의 `.seorilabs/app.yaml`과 제품 문서를 따른다.
- `Done`은 merge가 아니라 검증, 배포, live 확인, 문서 갱신까지 끝난 상태다.

## Agent Contribution

Claude, Codex, Gemini Bot 등 automation agent가 만든 PR은 추가로 다음 기준을 충족해야 한다.

- 티켓 없이 임의로 큰 작업을 시작하지 않는다.
- PR description에 `Refs #...` 또는 `Closes #...`를 적는다.
- 변경 기준이 된 spec 또는 문서 경로를 적는다.
- `Version Impact`를 `none`, `patch`, `minor`, `major` 중 하나로 제안한다.
- 실행한 검증 명령과 결과를 적는다.
- 테스트를 못 돌렸다면 이유와 대체 검증을 적는다.

자세한 계약은 [Agent Contribution Contract](https://github.com/seorilabs/.github/blob/main/docs/agent-governance/agent-contribution-contract.md)를 따른다.

## PR Before Opening

- default branch에서 최신 코드를 받는다.
- 변경 범위를 한 티켓 안에 유지한다.
- 문서·번역·에셋·자동 생성·lock 파일을 뺀 추가·삭제 줄이 1,500줄을 넘으면 리뷰 요청 전에 PR을 나눌 수 있는지 먼저 검토한다. 나누지 못하면 이유를 PR에 남긴다. 큰 PR은 리뷰 반영이 새 코드를 만들고 그 코드가 다시 지적받는 반복이 길어진다.
- 불필요한 formatting churn을 피한다.
- repo-local test, lint, smoke command를 우선 사용한다.
- public repo 또는 fork PR 경로에서 self-hosted runner가 노출되지 않게 주의한다.
- Android release build와 Apple App Store build를 Seorilabs RPI ARC runner로 보내지 않는다.

## Review And Merge

- Seori는 PR 최초 턴에 인수조건 가이드를 한 번 제공한다. 요구사항을 반영하거나 같은 thread에 근거를 답하고 Resolve한다.
- 새 push마다 Seori AI review를 다시 요청하거나 Seori approval을 기다리지 않는다.
- 리뷰 요청 대상과 예외는 `contracts/review-policy.yaml`이 정본이다. 적용 대상 단계는 `optional: false`로 리뷰 요청이 필수다. 결과는 `advisory`, `countsAsApproval: false`, `blocking: false`이며 사람 승인이나 저장소 필수 검사를 대신하지 않는다. 리뷰 불가 사유와 자체 점검을 기록하고 아래 실패·보안 조건을 적용한다.
- 문서·주석·번역 문구·에셋 바이너리·자동 생성물·릴리스 문구와 버전 메타데이터만 바뀌면 요청하지 않는다. `seorilabs-backoffice`, `seorilabs-official`, `.github`의 일반 코드·설정 변경도 요청을 생략한다. 단, 보안·결제·데이터 형식과 무결성·릴리스 실행 로직 변경은 세 저장소에서도 교차 리뷰 대상이다. 이 예외는 다른 저장소에 적용하지 않는다.
- 결함 검토는 CI와 작성자 자체 검토가 끝난 최종 HEAD에서 리뷰어 하나에게 요청한다. 1차 리뷰 반영이 새 함수·파일·분기를 만들었거나 아래 실패 처리에서 재요청이 허용된 경우에만 한 번 더 요청한다. PR당 총 요청은 실패·대체·재시도를 포함해 최대 2회다.
- 다음 중 하나에 해당하면 작성 agent와 다른 회사 모델에 교차 리뷰를 요청한다. Copilot은 아래 대체 요청일 때만 요청한다.
  - 보안 민감 변경: 인증·권한, 자격증명, 결제·인앱결제, 개인정보, 보안 규칙, GitHub Actions·릴리스 워크플로
  - 결제·인앱결제 동작, 데이터 스키마·저장 형식·마이그레이션·삭제·복구·무결성 변경
  - 릴리스 실행 변경: 빌드·서명·업로드·승격·배포 로직과 권한. 릴리스 문구·버전 값만 바뀐 경우는 제외
  - 문서·번역·에셋·자동 생성·lock 파일을 뺀 추가·삭제 줄이 500줄 이상인 변경
- 교차 리뷰 요청 방법은 작성 agent에 따라 다르다.
  - Claude가 작성: PR 코멘트에 `@codex review`, 보안 민감 변경이면 `@codex review for security issues`를 남긴다. 반드시 `@codex review`로 시작한다. `@codex /review`처럼 다른 문구는 리뷰가 아닌 Codex 작업 요청으로 처리돼 실행 환경을 요구한다.
  - Codex가 로컬에서 작성: 최종 HEAD의 `origin/main` 대비 diff를 넘겨 로컬 Claude Code를 읽기 전용으로 실행하고, 출력 원문을 PR 코멘트로 올린다. 리뷰어는 파일 수정, 커밋, 코멘트, 다른 리뷰 요청을 하지 않는다.
  - Codex 클라우드가 작성: Claude 리뷰를 부를 수 없으므로 Copilot Balanced를 요청하고 PR에 교차 리뷰를 하지 못한 이유를 남긴다.
- 그 밖의 리뷰 대상 코드·설정 변경은 Copilot Lite(`@copilot`)를 요청한다. 조직 운영 기본값은 Lite이며 GitHub 서비스의 기본값을 그대로 따른다고 가정하지 않는다. `gh pr edit --add-reviewer @copilot`은 깊이를 명시하지 않으므로 요청 계정의 개인 기본값을 Lite로 확인하거나 PR별 선택을 사용한다. API로 깊이를 명시하려면 현재 공식 입력을 확인하고, 확인되지 않은 필드를 넣지 않는다. 리뷰 요약의 `Review effort`로 실제 깊이를 확인한다.
- Copilot이 `encountered an error` 리뷰를 남기면 head SHA의 `Running Copilot Code Review` Actions 로그와 공급자 응답에서 원인을 확인한다. `rate_limit` 문자열만으로 월간 소진이나 일시 제한을 단정하지 않는다. 월간·주간 사용량 또는 예산 소진이 확인되면 초기화나 사용 권한 회복이 확인되기 전 같은 리뷰어에게 재요청하지 않는다. 일시 제한은 공급자가 제시한 재시도 시각 이후 최종 HEAD에서 한 번만 재요청할 수 있다. 시각·원인이 불명확하면 자동 재요청하지 않는다. 그 밖의 오류도 최종 HEAD에서 한 번만 재요청한다. 모두 총 요청 2회 상한 안에서 수행한다.
- 한도로 리뷰할 수 없으면 원인·공급자가 제시한 초기화/재시도 시각·자체 점검 결과를 PR에 남긴다. 시각이 없으면 미확인으로 기록하고 추정하지 않는다. Pro+ 구독은 사용 제한 면제를 뜻하지 않으며, 추가 과금이나 예산은 임의 변경하지 않는다.
- 교차 리뷰어의 사용량 소진 또는 사용 불가가 확인되면 사유를 기록하고 상한 안에서 Copilot Balanced를 한 번 요청한다. 요청별 Balanced 선택을 사용하고 개인 Lite 기본값을 임시 변경하지 않는다. 보안 민감 변경이 교차 리뷰를 받지 못했으면 대체 리뷰 결과와 관계없이 병합 여부를 사람에게 확인한다.
- 리뷰 지적은 이 PR 범위 안에서 어떤 입력이나 상태에서 무엇이 틀리는지 실패 시나리오를 댈 수 있을 때 수용한다. 리뷰어가 붙인 심각도만으로 수용하지 않는다. 실패 시나리오 없이 더 엄격한 검증이나 가장자리 입력 거부를 요구하는 지적은 근거를 들어 소명하거나 후속 이슈로 돌린다.
- 2회차 리뷰는 수정 확인만 한다. 1회차 리뷰 커밋 이후 변경분과 1회차 지적·처리 결과를 넘기고, 소명한 지적은 다시 올리지 말라고 지시한다. Codex는 `@codex review` 뒤에 범위 지시를 붙이고, 로컬 Claude에는 1회차 커밋 이후 diff만 넘긴다. Copilot은 범위를 지정할 수 없다.
- 2회차 뒤에는 리뷰를 다시 요청하지 않는다. 2회차 지적 중 1회차 수정이 만든 결함만 고치고 테스트로 확인하며, 나머지는 후속 이슈로 돌린다. 2회차에도 같은 영역에서 실패 시나리오가 있는 결함이 나오면 리뷰를 더 돌리지 않고 PR 분할이나 설계 재검토를 사람에게 확인한다.
- Codex 인라인 지적은 Copilot 지적처럼 thread에 답하고 Resolve한다. thread가 없는 로컬 Claude 리뷰는 지적마다 처리 결과를 PR 코멘트 하나에 답한다.
- CI failure, unresolved Seori/Copilot/Codex thread, 처리 결과를 답하지 않은 로컬 Claude 리뷰 지적, merge conflict, 실제로 요구되는 사람 승인은 merge blocker다.
- release 영향이 있는 PR은 release approval 전 배포하지 않는다.
- source-of-truth 문서가 repo 현실과 어긋나면 문서를 먼저 갱신한다.
