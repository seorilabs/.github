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
- 불필요한 formatting churn을 피한다.
- repo-local test, lint, smoke command를 우선 사용한다.
- public repo 또는 fork PR 경로에서 self-hosted runner가 노출되지 않게 주의한다.
- Android release build와 Apple App Store build를 Seorilabs RPI ARC runner로 보내지 않는다.

## Review And Merge

- Seori는 PR 최초 턴에 인수조건 가이드를 한 번 제공한다. 요구사항을 반영하거나 같은 thread에 근거를 답하고 Resolve한다.
- 새 push마다 Seori AI review를 다시 요청하거나 Seori approval을 기다리지 않는다.
- 결함 검토는 CI와 작성자 자체 검토가 끝난 최종 HEAD에서 Copilot review를 한 번 요청한다. 1차 리뷰 반영이 새 함수·파일·분기를 만들었거나 사용 한도가 아닌 오류로 리뷰가 실패한 경우에만 최종 HEAD에서 한 번 더 요청한다. PR당 총 요청은 실패를 포함해 최대 2회다.
- agent 요청은 요청 계정의 기본 리뷰 깊이(Lite)로 실행되고, API로는 깊이를 지정할 수 없다. 보안 민감 변경(인증·권한, 자격증명, 결제·인앱결제, 개인정보, 보안 규칙, GitHub Actions·릴리스 워크플로)은 agent가 요청하지 않고 PR 코멘트로 사람에게 PR 화면의 Balanced 요청을 부탁한다. 그 리뷰를 처리하기 전에는 병합하지 않는다.
- Copilot이 `encountered an error` 리뷰를 남기면 head SHA의 `Running Copilot Code Review` Actions 실행 로그에서 원인을 확인한다. `errorType: 'rate_limit'`이면 재요청하지 않고, PR에 사용 한도로 리뷰할 수 없음과 초기화 시각, 작성자 자체 점검 결과를 남긴 뒤 나머지 gate로 진행한다. 보안 민감 변경의 Balanced 리뷰가 한도로 실패하면 병합 여부를 사람에게 확인한다.
- CI failure, unresolved Seori/Copilot thread, merge conflict, 실제로 요구되는 사람 승인은 merge blocker다.
- release 영향이 있는 PR은 release approval 전 배포하지 않는다.
- source-of-truth 문서가 repo 현실과 어긋나면 문서를 먼저 갱신한다.
