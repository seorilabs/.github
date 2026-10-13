# Jomul v1.1.2 심사 제출 검증 예외

사용자가 2026-10-13에 중앙 검증 예외와 장비 검수 생략, Google Play·App Store 심사 제출을 명시 승인했다. 승인 근거는 [jomul #200](https://github.com/seorilabs/jomul/issues/200)이다. 제품 소스·태그는 유지한다.

```mermaid
flowchart LR
  A[릴리스 검증 요청] --> B{중앙 승인 목록의 정확한 후보인가}
  B -->|아니오| C[기존 UI/E2E 검증]
  B -->|예| D[현재 GitHub 태그와 SHA 대조]
  D --> E[human-exception 결과와 예외 판단 시각 기록]
  E --> F[서명·산출물·SDK 감사·업로드·심사 상태 확인]
```

승인 범위는 `seorilabs/jomul`, `v1.1.2`, `975d2e8c555bcb43f37a9034c881bfb17574cfea`, 두 마켓의 before-build/before-deploy다. 2026-10-20T08:42:25Z에 만료하고 두 마켓 접수 확인 뒤 승인 항목을 제거한다. 공개 출시는 승인 범위에 없다. UI 26 통과/4 차단, 별도 E2E 미실행, 실기기 생략은 검증 성공으로 바꾸지 않는다.

## 구현과 실패 처리

중앙에서 검토한 승인 기록만 읽고 일반 CLI/환경변수 생략 옵션은 추가하지 않는다. 후보·마켓·phase·시각이 다르면 기존 검증 경로를 쓴다. 실제 annotated tag를 읽고 commit SHA가 다르거나 조회에 실패하면 예외도 거절한다. 예외 결과는 `human-exception`, `productE2eStatus:blocked`와 승인 기록 ID를 출력한다. 이미 발급한 고정 태그의 호환 경로이며 두 마켓 제출 후 전용 승인 목록과 코드를 제거한다. 새로운 릴리스에는 최신 명시적 grant 경로를 쓴다. Xcode Cloud 기존 훅이 필요로 하는 `completed_at`은 E2E 완료/실제 예외 판단 완료 시각이며 실제 E2E 실행을 뜻하지 않는다. 기존 훅의 `--after`를 지원하고 시각 역전은 거절한다.

## 인수조건과 검증

1. 정확한 후보·두 마켓·두 phase만 승인 범위 안에서 예외 처리한다. 만료/다른 후보/다른 마켓은 예외가 없다.
2. 변경된 실제 태그·읽기 실패는 차단한다.
3. 실패·미실행 기록을 통과로 만들지 않고 정상 E2E 검증을 보존한다.
4. 기존 Xcode Cloud receipt 인터페이스와 배포 전 시간 대조가 동작한다.
5. 의미 있는 단위·통합·CLI 테스트, 전체 npm test, 독립 Claude 코드 리뷰와 required check 후 병합한다. 제품 UI 변경이 없어 새 UI 검수는 해당 없음이다.

중앙 승인 항목 삭제 또는 만료는 즉시 원래 검증으로 복귀한다. 관련 티켓: jomul #200. Version Impact: patch.

## 사용 종료 — 2026-10-13

Google Play 제출 `14`는 검토 중이며, App Store `1.1.2 / build 31`은 제출 `7f50faff-d6e0-4b49-8123-01999b319c36`으로 `WAITING_FOR_REVIEW`다. App Store의 실제 제출 항목 하나·선택 빌드·수동 출시를 재조회했다. Google Play 관리형 게시와 App Store 수동 출시로 공개는 보류한다.

승인 당시 정한 제거 조건에 따라 Jomul 전용 승인 목록·모듈·자동 예외 분기·전용 로그·무결성 경로를 제거한다. 이 후보도 이후 새 검증 요청에는 정상 근거가 필요하다. 두 마켓·두 phase의 정상 근거 복귀 검사 4개가 수정 전 실패, 수정 후 통과했다. 정상 `completed_at`·`--after` CLI 회귀는 별도 파일로 옮겨 유지한다. 기존 Reascend 명시적 grant 계약과 런타임 무결성 검사를 보존한다.

전체 `npm test` 438개와 배포 패키지 검사를 통과했다. 최초 전체 검사의 로컬 HTTP 서버 `EPERM`은 환경 제한으로 보존하고 같은 검사를 제한 밖에서 확인했다. 심사 접수는 기존 UI/E2E의 미충족 항목을 통과로 바꾸지 않는다.
