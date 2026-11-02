# 앱인토스 검수 근거 읽기 권한

2026-10-22 사용자가 “네 곳의 읽기 권한만 수정”으로 조물조물 Play, 앱인토스, Deploy All 호출부와 이 중앙 앱인토스 워크플로의 actions: read 한 줄씩을 승인했다. 자격증명과 쓰기 권한은 변경하지 않는다. 실행 티켓은 조물조물 #207과 #209다.

배포 직전 검증기는 후보 SHA의 실제 CI를 GitHub API로 읽는다. 중앙 godot-deploy-ait.yml의 명시적 권한에는 현재 contents: read만 있어 actions가 none으로 떨어진다. actions: read를 더하고 기존 permissions 계약 검사도 맞춘다. 검증기, 태그와 원장, 산출물, 서명, 러너, 마켓 동작은 변경하지 않는다. 제품 화면과 저장 변경이 없어 화면 검수와 기기 실행 대상은 아니다.

L1 dev 정적 검사로 npm test, pack:check, actionlint, diff check와 PR CI를 실행한다. MiniMax Code 로컬 리뷰 뒤 한국어 Ready PR을 사용한다. 기존 CI API 읽기 검증의 권한 계약을 새 값으로 먼저 바꾸어 실패를 남기고 한 줄 구현 뒤 통과시킨다.

## 기존 호출부 호환성과 병합 조건

현재 원본을 조회한 결과 조물조물 외 foam-party 2곳, lucid-reversi 1곳, alley-market-match 2곳, match-picture-app 2곳의 명시적 권한에 actions: read가 없다. 중앙 요구 권한을 먼저 올리면 이 호출부의 실행이 거절된다. 이 일곱 곳의 수정은 승인된 네 곳 범위를 넘으므로 추가 승인 전에는 수정하지 않는다. 승인된 호출부와 기존 호출부의 상한이 모두 일치한 원본 재조회 전에는 이 중앙 변경을 병합하지 않는다. 중앙 PR의 정적 통과를 앱인토스 배포 성공으로 표시하지 않는다.

중앙 변경은 PR 전까지 격리 worktree에 보관한다. 병합 후 문제가 있으면 중앙 한 줄을 되돌리는 후속 PR로 복구하며 다른 제품 소스와 마켓은 변경하지 않는다.
