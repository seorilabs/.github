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


## 실제 첫 빌드 실패 뒤 재결속

#333은 `betta-0-1-0-google-first-internal-r1`을 등록한다. 이전 grant는 #332에서 회수했고 원본 파일·첫 claim·실패는 보존한다. 수정된 verifier commit은 `038dbca5e103983e24c6b8e906cfbd8d95a361fe`다. 같은 bd78bd9/v0.1.0/code1·설정 지문·서명·99개 입력과 최초 승인·만료는 바뀌지 않는다. grant ID와 verifier commit, 원본 관측 1개 추가만 변경한다.

첫 physical run [43286867642](https://github.com/seorilabs/betta-raising/actions/runs/43286867642)는 실제 114,386,125바이트 signed AAB를 만들었지만 before-deploy `BETTA_UNTRACKED_SOURCE`에서 중단됐다. actual uploader 단 하나의 conclusion은 skipped이고 before-deploy claim은 없다. 2026-11-12T19:31:41Z Play API에서도 bundle/APK와 모든 track이 비어 있다. 실제 AAB는 JAR 서명·certificate `e3643eed86dd6bd5d91a4b8c9f9e7e4636f9fc30bd8cdb6d7688800333d71a8a`·SDK26/36·portrait·0.1.0/code1을 작성자와 독립 검토자가 재확인했다. artifact SHA-256은 `33ef4d1103c2ebea66c5f8d478b32de559b859747f2dc44faf2e241ba09d60eb`다.

첫 build 실패·raw logs·실제 run/jobs·원래 grant·첫 claim·실제 artifact 검사·빈 Play readback은 여덟 번째 원본 `historical-first-native-build-failure.bd78bd9.json`(664,134바이트, SHA-256 `961c88cbac8b973dc216b891eab902e3623524f3e6173a4e5e732ba1345365d8`)에 봉인하고 Release에서 다시 읽어 검증했다. 새 ID가 첫 physical run을 지우지 않는다. source 전체 provider run 이력과 실제 skipped uploader를 조회해 다음 claim은 attempt2로 만든다. 새 namespace에서 old-ID 요청 실패 proof를 자동 상속하지 않으며 다른 경우 접수 불명은 계속 거부한다. 총2build/1accepted 한도와 정상 제품 QA blocked는 유지한다. 세 번째 빌드는 허용하지 않는다.


## 기존 AAB의 추가0build 업로드 결속

`betta-0-1-0-existing-aab-upload-only`는 이미 검증한 첫 artifact13975726650 한 개만 재사용한다. Source bd78/v0.1.0/code1, AAB SHA33ef4d1103c2ebea66c5f8d478b32de559b859747f2dc44faf2e241ba09d60eb, archive SHA1816e94e6473a9728a34efbcffb09f5930cb9037a898171a9eabf973c88975c5와114,386,125바이트를 고정한다. 최초 승인·만료·설정·서명·99입력·원래QA를 유지하고 source working-tree 전체 감사는 false다. 첫 native실패와 두번째runner-loss의 원본을 포함한9개 관측을 봉인한다. 두 기존grant는 회수 상태다.

검토된 verifier는 c55980f9d308fff27d7380f03e4d630dc3db147a, 별도 caller는9ff287c10ef6c22663c5ca99efbfe95cb14d3344(파일SHA2141c870bbbb34d49828d871c2c31e714eb9228ae7f35dc3279b2fe2cccd6864)다. Caller PR4는 Ready 미병합이며 게임PR2와 main은 유지한다. Caller의 실제 CI43302190749와 작성자Mac headless58여정이 통과했다. 이는 uploader 코드검증이며 제품원본bd78의 기존 sourceCI43281443421과 구분한다. 신규GUI회차나 정상제품QA 통과가 아니다.

Annotated 운영tag betta-existing-aab-upload-0.1.0는 caller코드 선택에만 쓴다. 제품버전/원장은 v0.1.0/code1 그대로다. 추가게임빌드0회, 전송은 package/version 단일global intent와 두legacy슬롯의원자적fence 뒤 최대1접수만 허용한다. 모든422/부분완료/응답유실 뒤 자동재시도·슬롯삭제·tag재지정·rerun을 하지 않는다. 정확한tag/push/code/hash/원래CI·claim·실제provider·원장·승인·원본실패와freshPlayempty를 runtime에서 다시 확인한다.

첫 grant 생성 시 GET main ref가HTTP502로 실패했으며 변경·claim·업로드는 없었다. 읽기만 재시도해 실제 tuple을 확정했다. 이 transient준비실패도 별도로 보존한다. 이등록이 기존정상QA·네이티브QA·공개권한을 바꾸지 않으며 Apple 로그인/등록/Cloud준비는 별도로 남는다.


## 예약 전 다운로드 실패의 단일 재시도

기존0build run43309802883 attempt1은 artifact ZIP GET에서 HTTP415로 중단됐고 예약·Google 전송 전이었다. 실제 job131502589080의 원문54,619바이트 SHA7b1c02bf73195e25ed1343f8e0cfabafdc0ce356106fd0511c16169cb215f1be와 당시 grant14a91b319cf7d0bc7b9c31bef7bac838b35af3be03b615a8b0df748a1269b51f·verifier c55980f9·실제 reusable6e7e9a40·빈 Play·예약 없음을10번째 관측에 봉인했다. 관측 asset741202216,167,556바이트,SHA c7e170984be213063ec096d219b04e1290f68177c26ba7e0c2733267762fc84f를 Release에서 다시 읽어 검증했다.

새 grant betta-0-1-0-existing-aab-upload-only-preflight-r1의 SHA는119ce200ed5c383704d4cd10e9bfc05b368f9418b71c887efdede9858c4845dd, verifier는a3a79a32bd1cc2be7dae54cf3aeeacf06471c8f2다. 이전3grant는 회수됐다. source bd78, caller9ff, 같은 불변tag와 run의 attempt2만 허용한다. 최초9관측·C13 승인 시각과 만료·2native/1accepted·QA blocked·전체 working-tree 감사false를 유지한다. 추가 게임빌드0회다. 새 grant 등록을 확인한 뒤에만 all-jobs rerun을1회 실행하며 --failed·tag 변경·attempt3·예약 후 재시도는 허용하지 않는다.
