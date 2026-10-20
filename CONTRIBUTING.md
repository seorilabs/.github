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
- 코드 리뷰 의무와 예외는 `contracts/review-policy.yaml`이 정본이다. 조직은 Copilot이나 다른 봇에 리뷰를 요청하지 않는다. 코드나 설정 로직이 바뀐 PR은 작성 agent가 Ready로 올리기 전에 로컬 모델 리뷰(`local-model-review`)를 한 번 돌린다. 결과는 `advisory`, `countsAsApproval: false`, `blocking: false`이며 사람 승인이나 저장소 필수 검사를 대신하지 않는다. 저장소 예외는 없다.
- 문서·주석·번역 문구·에셋 바이너리·자동 생성물·릴리스 문구와 버전 메타데이터만 바뀌면 돌리지 않는다.
- 로컬 모델 리뷰는 MiniMax Code(`mcode`)를 작성 agent의 로컬 환경에서 읽기 전용 지시로 실행한다. 작성 agent가 최종 HEAD의 `origin/main` 대비 diff를 만들어 넘기고, 리뷰어는 파일 수정, 커밋, push, PR 코멘트, 다른 리뷰 요청을 하지 않는다. 실행 전후 작업 트리 내용이 같은지 확인하고, 바뀌었으면 되돌린 뒤 한 번만 다시 실행한다. 실행 명령과 프롬프트는 `~/.agent`의 `seori-pr-workflow` 스킬이 보유한다.
- 리뷰 출력은 PR에 올리지 않는다. 지적은 이 PR 범위 안에서 어떤 입력이나 상태에서 무엇이 틀리는지 실패 시나리오를 댈 수 있을 때만 수용해 고치고, 그 밖의 지적은 답하지 않고 버린다. 리뷰어가 붙인 심각도만으로 수용하지 않는다. 실패 시나리오 없이 더 엄격한 검증이나 가장자리 입력 거부를 요구하는 지적에 소명 턴을 쓰지 않는다.
- 2회차는 수용한 수정이 새 함수·분기·파일을 만들었을 때만 돌린다. 1회차 리뷰 출력과 처리 결과, 1회차 리뷰 커밋 이후 diff만 넘긴다. 2회차 뒤에는 리뷰를 다시 돌리지 않는다. 2회차 지적 중 1회차 수정이 만든 결함만 고치고 테스트로 확인하며, 나머지는 후속 이슈로 돌린다. 2회차에도 같은 영역에서 실패 시나리오가 있는 결함이 나오면 PR 분할이나 설계 재검토를 사람에게 확인한다.
- 리뷰 실행이 실패하면 원인을 확인한 뒤 한 번만 다시 실행한다. 사용 한도 소진은 자동으로 다시 실행하지 않는다. 그래도 리뷰를 받지 못하면 PR 본문에 원인을 한 줄 적고 자체 점검으로 진행한다. 다른 공급자에게 대체 요청을 하지 않고 추가 과금이나 예산을 변경하지 않는다.
- 결함 판단의 1차 책임은 작성 agent에 있다. 리뷰를 받아도 위험 지점을 직접 점검하고 근거를 PR에 남긴다.
- Seori 인수조건 thread는 같은 thread에 근거를 답하고 Resolve한다.
- CI failure, unresolved Seori thread, 수용했지만 고치지 않은 로컬 리뷰 지적, merge conflict, 실제로 요구되는 사람 승인은 merge blocker다.
- release 영향이 있는 PR은 release approval 전 배포하지 않는다.
- source-of-truth 문서가 repo 현실과 어긋나면 문서를 먼저 갱신한다.
