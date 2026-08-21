# AGENTS.md

## 저장소 역할

- 이 저장소는 Seorilabs 조직 공통 계약, 프로필, 템플릿, 재사용 워크플로우의 정본이다.
- 기계 판독 계약은 `contracts/`, stack별 요구사항은 `profiles/`, 실행 구현은 `.github/workflows/`를 우선한다.
- `docs/`는 설명과 마이그레이션 기록이다. 기계 판독 계약과 충돌하면 계약을 우선하고 문서를 함께 바로잡는다.

## 변경 규칙

- 비밀값, 인증서, 키 파일, 토큰을 계약·예제·로그에 넣지 않는다. logical ID와 consumer 위치만 기록한다.
- 동일 정책을 앱 저장소나 Backoffice에 복사하도록 안내하지 않는다. 앱 저장소에는 `.seorilabs/app.yaml`과 앱 고유 설정만 둔다.
- `~/.agent`의 전역 guardrail과 task skill은 로컬 agent 설정의 정본으로 유지한다. 조직 계약을 배포할 때는 정책 전문을 복사하지 않고 `contracts/agent-policy.yaml`에 따라 계약 commit·schema·checksum과 skill routing만 추가한다.
- `schemaVersion` 호환 범위에서는 필드를 비파괴적으로 추가한다. 기존 의미를 깨는 변경은 새 major 계약으로 분리한다.
- `main`과 PR은 정적 게이트만 실행한다. 마켓 업로드는 명시적 Release 또는 Tag와 별도 승인 경로로만 수행한다.
- Apple archive와 App Store 업로드의 표준 실행 환경은 Xcode Cloud다.
- 공통 workflow caller는 immutable commit SHA로 고정하고 필요한 Secret만 명시적으로 전달한다.
- 구현, artifact, upload, device QA, review, approval, deployment, public availability를 서로 다른 상태로 표현한다.

## 검증

```bash
npm ci
npm test
actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml
git diff --check
```
