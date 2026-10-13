# MP-IOS-117-R1 v1 실행 기록

사람이 승인한 설계는 commit `783b0e932798e11d96bae8380b39c2ebe84c9ac1`의 design.md이며 본문 bytes를 바꾸지 않는다. [원문 승인 receipt](../../../contracts/release-exceptions/match-picture-1.1.7.approval.json)는 최초 확인 가능한 수신 기록 시각과 실제 사용자 문구를 보존한다.

## 대안·주요 결정

| 대안 | 선택·근거 | 영향 | 확인 방법 |
|---|---|---|---|
| 정상 실기기 Editor/마켓 검수 | 이번 릴리스에는 사용자가 실기기 실행을 생략하도록 승인 | iPhone/iPad·ATT/UMP·실제 광고·Game Center 미검증 | 원래 native not_verified/blocked를 유지하고 승인 위험에 결속 |
| 기존 Reascend/Xcode Cloud grant 재사용 | 선택하지 않음: 엔진·공개 hosted 소비 경로·13개 inventory·release-tag Apple build authority가 다름 | 기존 26기능/Xcode Cloud contract를 바꾸지 않음 | 기존 전체 회귀와 provider mismatch 거절 검사 |
| 공개 Godot 한 릴리스 v2 grant | 선택: 현재 앱·태그·bundle·마켓 한 건에 좁게 제한 | 예외를 제품 E2E PASS로 표시하지 않으며 새 제품 기능/analytics를 추가하지 않음 | 실제 최종 Editor 원본, 후보/caller/hash·설정·실제 hosted run/workflow·SDK/서명/receipt 결속 |

실제 기존 CI의 GA4 secret 미설정/미주입과 blank analytics.config.json을 확인했다. 설정을 활성화하지 않고 비활성 bytes를 결속하며 공개 개인정보 문구도 실제 설정과 대조한다. 승인 기록·원본·위험·출시 notes는 중앙과 Release assets에 담으므로 앱 후보의 허용 변경은 caller 한 파일뿐이다.

## 병합·근거·공개 순서

1. 중앙 실행 지원 PR #241을 병합한다. grant는 아직 등록하지 않는다.
2. 중앙 main의 새 입력 선언을 읽은 뒤 앱 caller PR #114를 병합한다.
3. 최종 앱 source SHA와 설정을 고정해 승인된 빌드 전 Editor 검수를 실제 실행한다. native 미검증은 유지한다.
4. 실제 Editor 원본·inventory·approval·설정·후보로 grant를 별도 중앙 PR에 등록하고 리뷰·검사·병합한다.
5. 공식 태그 receipt와 버전 원장을 사용한다. actual CI의 before-build/deploy 보고서·SDK/서명 검사·artifact receipt를 마켓 업로드 전에 보존한다. 중앙 artifact retention은 3일이며 실제 실행 직후 Release assets와 원본 저장소에도 보존한다.
6. 개인정보·버전별 메타데이터를 저장하고 읽어 대조한 뒤 같은 거절 제출에 1.1.7로 재심사를 신청한다. 이번 운영에서는 releaseType을 MANUAL로 저장한다.
7. Apple 승인 후 공개 직전에 최신 중앙 main grant의 변경/철회/만료, 승인 후보/설정, 실제 성공 CI·SDK/서명·개인정보·메타데이터 readback을 다시 확인한다. 만료·철회·변경이면 공개하지 않는다. 심사 대기를 공개 완료로 표시하지 않는다.

## 검수 범위

Editor에서 실제 확인한 범위와 native/마켓 실행 미검증을 분리한다. 최종 Editor JSON의 실제 시작/종료 시각·13항목·후보/설정/원본 해시를 요구한다. 소명한 범위 축소를 통과 판정으로 대체하지 않는다. 앱·중앙 릴리스 로직은 별도 교차 리뷰 및 current HEAD CI·미해결 thread 0개를 확인한다.
