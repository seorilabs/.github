# 제품 기능·회귀 검증 계약

## 목적

PR에서 구현한 기능과 기존 핵심 흐름이 실제 입력 연결을 통해 함께 동작하는지 빠르게 검증한다.
기계 판독 정본은 [`contracts/product-verification.yaml`](../../contracts/product-verification.yaml)과
[`contracts/product-verification.schema.json`](../../contracts/product-verification.schema.json)이다.

기존 `test:core`, `check:architecture`, `check:release`는 구조와 정적 준비 상태를 확인한다. 제품 검증은
그 위에서 다음 세 명령을 모두 실행한다.

- `test:feature`: PR 인수조건과 새 상태 전이
- `test:regression`: 기존 핵심 흐름, 저장·재시작·실패 경계
- `test:ui-contract`: 버튼·탭·드래그 같은 실제 입력 신호와 화면 전환

호출 저장소는 명령을 workflow 입력으로 넘기지 않는다. 중앙
[`godot-product-verification-v1.yml`](../../.github/workflows/godot-product-verification-v1.yml)이 고정된
명령을 실행하며, 최종 check는 `Product Verification / Product Verification`이다. caller workflow는
`pull_request`, `push`의 main, `merge_group`에서 항상 실행해야 하며 path filter로 전체 workflow를
건너뛰지 않는다.

## EVALUATE 범위

- 대상: `seorilabs/lizard-tycoon`
- 프로필: Godot 4.7.2
- 러너: private repo는 `seorilabs-rpi-arm64`, public repo는 `ubuntu-latest`
- 배포·마켓 업로드·서명 빌드: 실행하지 않음

EVALUATE 동안에는 조직 ruleset이 병합을 막지 않는다. 대상 저장소의 caller와 세 명령이 main에
반영되고 대표 PR에서 check 이름·최신 SHA·실패 전파를 확인한 뒤 `ACTIVE` 전환을 별도 승인한다.

## PR과 release QA 경계

PR 필수 검증은 네트워크와 실시간 대기를 제거한 결정적 headless 검사다. UI 변경은 저장소 검증
명령에서 해상도·언어·모션 조합의 렌더 또는 레이아웃 불변식을 포함한다. Android·iOS·AppsInToss
artifact, Simulator, 실기기 QA는 release 후보에서 수행하며 PR 정적 성공으로 대체하지 않는다.
