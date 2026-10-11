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
- 결함 검토는 CI와 작성자 자체 검토가 끝난 최종 HEAD에서 리뷰어 하나에게 요청한다. 1차 리뷰 반영이 새 함수·파일·분기를 만들었거나 사용 한도가 아닌 오류로 리뷰가 실패한 경우에만 최종 HEAD에서 한 번 더 요청한다. PR당 총 요청은 실패와 대체 요청을 포함해 최대 2회다.
- 다음 중 하나에 해당하면 작성 agent와 다른 회사 모델에 교차 리뷰를 요청한다. Copilot은 아래 대체 요청일 때만 요청한다.
  - 보안 민감 변경: 인증·권한, 자격증명, 결제·인앱결제, 개인정보, 보안 규칙, GitHub Actions·릴리스 워크플로
  - 데이터 스키마·저장 형식·마이그레이션 변경
  - 문서·번역·에셋·자동 생성·lock 파일을 뺀 추가·삭제 줄이 500줄 이상인 변경
- 교차 리뷰 요청 방법은 작성 agent에 따라 다르다.
  - Claude가 작성: PR 코멘트에 `@codex review`, 보안 민감 변경이면 `@codex review for security issues`를 남긴다. 반드시 `@codex review`로 시작한다. `@codex /review`처럼 다른 문구는 리뷰가 아닌 Codex 작업 요청으로 처리돼 실행 환경을 요구한다.
  - Codex가 로컬에서 작성: 최종 HEAD의 `origin/main` 대비 diff를 넘겨 로컬 Claude Code를 읽기 전용으로 실행하고, 출력 원문을 PR 코멘트로 올린다. 리뷰어는 파일 수정, 커밋, 코멘트, 다른 리뷰 요청을 하지 않는다.
  - Codex 클라우드가 작성: Claude 리뷰를 부를 수 없으므로 Copilot review를 요청하고 PR에 교차 리뷰를 하지 못한 이유를 남긴다.
- 그 밖의 코드·설정 변경은 Copilot review(`@copilot`)를 요청한다. 요청 계정의 기본 리뷰 깊이(Lite)로 실행되고, API로는 깊이를 지정할 수 없다.
- Copilot이 `encountered an error` 리뷰를 남기면 head SHA의 `Running Copilot Code Review` Actions 실행 로그에서 원인을 확인한다. `errorType: 'rate_limit'`이면 재요청하지 않고, PR에 사용 한도로 리뷰할 수 없음과 초기화 시각, 작성자 자체 점검 결과를 남긴 뒤 나머지 gate로 진행한다.
- Codex 교차 리뷰가 사용 한도 안내로 끝나면 재요청하지 않고 PR에 기록한 뒤 상한 안에서 Copilot review를 한 번 요청한다. 보안 민감 변경이 교차 리뷰를 받지 못했으면 병합 여부를 사람에게 확인한다.
- 리뷰 지적은 이 PR 범위 안에서 어떤 입력이나 상태에서 무엇이 틀리는지 실패 시나리오를 댈 수 있을 때 수용한다. 리뷰어가 붙인 심각도만으로 수용하지 않는다. 실패 시나리오 없이 더 엄격한 검증이나 가장자리 입력 거부를 요구하는 지적은 근거를 들어 소명하거나 후속 이슈로 돌린다.
- 2회차 리뷰는 수정 확인만 한다. 1회차 리뷰 커밋 이후 변경분과 1회차 지적·처리 결과를 넘기고, 소명한 지적은 다시 올리지 말라고 지시한다. Codex는 `@codex review` 뒤에 범위 지시를 붙이고, 로컬 Claude에는 1회차 커밋 이후 diff만 넘긴다. Copilot은 범위를 지정할 수 없다.
- 2회차 뒤에는 리뷰를 다시 요청하지 않는다. 2회차 지적 중 1회차 수정이 만든 결함만 고치고 테스트로 확인하며, 나머지는 후속 이슈로 돌린다. 2회차에도 같은 영역에서 실패 시나리오가 있는 결함이 나오면 리뷰를 더 돌리지 않고 PR 분할이나 설계 재검토를 사람에게 확인한다.
- Codex 인라인 지적은 Copilot 지적처럼 thread에 답하고 Resolve한다. thread가 없는 로컬 Claude 리뷰는 지적마다 처리 결과를 PR 코멘트 하나에 답한다.
- CI failure, unresolved Seori/Copilot/Codex thread, 처리 결과를 답하지 않은 로컬 Claude 리뷰 지적, merge conflict, 실제로 요구되는 사람 승인은 merge blocker다.
- release 영향이 있는 PR은 release approval 전 배포하지 않는다.
- source-of-truth 문서가 repo 현실과 어긋나면 문서를 먼저 갱신한다.
