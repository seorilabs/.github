# AGENTS.md

## 저장소 역할

- 이 저장소는 Seorilabs 조직 공통 계약, 프로필, 템플릿, 재사용 워크플로우의 정본이다.
- 기계 판독 계약은 `contracts/`, stack별 요구사항은 `profiles/`, 실행 구현은 `.github/workflows/`를 우선한다.
- `docs/`는 설명과 마이그레이션 기록이다. 기계 판독 계약과 충돌하면 계약을 우선하고 문서를 함께 바로잡는다.

## 변경 규칙

- 비밀값, 인증서, 키 파일, 토큰을 계약·예제·로그에 넣지 않는다. logical ID와 consumer 위치만 기록한다.
- 동일 정책을 앱 저장소나 Backoffice에 복사하도록 안내하지 않는다. 앱별 운영 설정의 정본은 Backoffice의 불변 `ConfigRevision`이며, 사람과 승인된 AI는 동일한 중앙 API·validator를 사용한다. 새 운영 JSON, `.seorilabs/app.yaml`, `.seorilabs/backoffice.json`을 별도 정본으로 추가하지 않는다.
- 저장소에서 탐지한 사실은 exact source SHA의 `DiscoveryObservation`, 공급자에서 조회한 실제 상태는 `ProviderObservation`으로 기록한다. 관측값으로 운영자가 지정한 설정이나 승인을 덮어쓰지 않는다. Gradle·Xcode 프로젝트·Godot export preset·Granite 설정 같은 실제 빌드 원본과 중앙 생성 thin workflow caller는 유지한다.
- 이관 전 운영 JSON과 기존 parser·consumer는 비교 대상으로 유지한다. 두 번 연속 shadow parity, 선언 마켓 build-only, 중앙 장애 시 복구 검증 등 현행 정리 gate를 통과하기 전에는 삭제하거나 이관 완료를 주장하지 않는다. 신규 중앙 등록·실행이 막혀 있으면 `needs_input`과 정확한 gate를 남기며 앱별 설정·키 생성으로 우회하지 않는다.
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
