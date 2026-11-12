# 첫 Google 내부 배포 결속

#327의 등록 대상은 `betta-0-1-0-google-first-internal`다. 사용자가 c13 준비안을 승인한 첫 내부 테스트 한정 범위이며 일반 QA·기기·공개 승인이 아니다.

- 저장소: seorilabs/betta-raising, private
- 정확한 소스: `bd78bd996987481d668185da815c6853c4e99a4b`
- 태그와 실제 원장 번호: `v0.1.0`, Android `1`
- 실제 성공 CI: https://github.com/seorilabs/betta-raising/actions/runs/43281443421
- verifier 코드: `dfc363a791e0d44e0ca096e4b90fdbf9a4318cf9`
- 대상: Google Play internal upload 한 개
- 설정 지문: `12c578594f2de4383e2bd0f4b1fe814e30905fca3d3dc7b7871218a69bce2363`
- 같은 후보 빌드 최대 2회, provider 접수 업로드 최대 1회
- 승인 관측: `2026-11-12T15:35:59.411730+00:00`, 만료: `2026-11-19T15:35:59.411730+00:00`

원래 v2를 실제 GitHub Release 자산으로 읽은 두 phase 판정은 `THREE_UI_ROUNDS_REQUIRED`다. 원래 판정을 유지한 human_exception이며 product E2E blocked, native QA unwaived, 공개 불가를 유지한다. 최신 main registry·회수·만료·실제 CI·provider 상태와 두 phase claim을 실행 때 다시 확인한다.

기존 C661의 1~4회 독립 검수 실패와 이번 준비 과정의 CI 두 실패·로컬 SHA 변경 실패를 원문으로 보존했다. 현재 후보 작성자의 Mac 렌더 자동 입력도 소환 결과 카드 선택에서 실패했다. 폰 동작은 확인하지 않았고 실험한 입력 도구 변경은 후보에 포함하지 않았다. 이 실패는 `author-render.bd78bd9.json`에 원문으로 봉인했으며 독립 검수 5회차나 통과로 계산하지 않는다. 총 7개 원본 관측 자산의 이름과 SHA-256이 grant에 묶인다.

99개 SDK·생성 번역 digest와 업로드 인증서 지문을 고정했다. 별도 임시 checkout에서 생성물 784개와 버전 주입을 source 감사에 대조했으나 이는 실제 게임 빌드·서명·업로드 증거가 아니다. 실제 signed AAB와 SDK·세로 화면·certificate 일치는 before-deploy에서 확인한다. 키·토큰·자격증명 값은 grant에 포함하지 않는다.

이번 등록에는 Apple provider ID나 grant를 넣지 않는다. Apple은 로그인 확인과 App Attest·새 profile·Cloud 등록이 남았으며, 현재 불완전한 profile로 실행하지 않는다. Google 채널 도달 후 이 grant를 회수한다. 같은 후보의 기존 claim과 실패 기록을 삭제해 한도를 초기화하지 않는다.
