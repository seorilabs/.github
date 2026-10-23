# RN iOS archive 프로파일 환경 변수 연결

가로세로 퍼즐 v1.2.0의 [실패 실행](https://github.com/seorilabs/crossword-puzzle/actions/runs/39971842702)은 archive 전에 중단됐다. 앱의 Release 구성은 `PROVISIONING_PROFILE_SPECIFIER = $(IOS_PROVISIONING_PROFILE_NAME)`을 읽지만 중앙 단계는 설치한 프로파일 이름을 `PROFILE_NAME`에만 전달한다. 설치 자체와 앱 프로젝트의 변수 참조는 확인됐다.

`rn-deploy-app-store.yml`의 `Archive with Xcode` 단계에서 설치 결과 `steps.signing.outputs.profile_name`을 `IOS_PROVISIONING_PROFILE_NAME`에도 전달한다. 기존 리터럴 이름을 쓰는 앱, 이름 일치 검사, 수동 서명과 Pods 타깃에 프로파일을 강제하지 않는 호출을 유지한다. 새 키, 프로파일, 앱 소스, 태그와 버전은 만들거나 바꾸지 않는다. 사용자 화면과 데이터 인터페이스 변경은 없다.

인수조건은 AC-1 변수 참조를 쓰는 앱이 설치한 이름으로 검사와 archive에 도달하고, AC-2 기존 리터럴 이름도 동작하며, AC-3 이름이 다르면 archive 전에 거부하는 것이다. 실제 YAML의 shell을 실행하되 외부 `xcodebuild` 명령만 대역으로 바꾸는 L1 개발 검수로 이 연결을 확인한다. 테스트의 실패와 통과, 전체 `npm test`, actionlint와 diff 검사를 보존한다. 이 검사는 Apple SDK, 실제 서명 또는 업로드 성공의 증거가 아니다.

2026-10-24 대화에서 사용자가 `/tmp/crossword-implementation-20261023.HQoMZH/release-preparation/ios-signing-pipeline-proposal.md`에 **“변수 연결 보완 후 진행”**이라고 승인했다. [실행 티켓 #312](https://github.com/seorilabs/.github/issues/312)에 범위와 인수조건을 고정했다. 이 중앙 변경은 PR 병합까지이며 `test-plan.json`의 `release`는 null이다. 앱 v1.2.0의 기존 공개 출시 승인은 별개로 유지된다.

로컬 모델 리뷰와 required check 후 병합한다. App Store Connect에 build 1002000이 없음을 다시 읽고 같은 v1.2.0 태그로 새 실행을 시작한다. 앱 후보는 `1cece06bb64e90ffba7b2406bccab6ac4baa84d6`을 유지한다. 실패하면 실제 단계와 로그를 보존하며 임의 서명 우회 없이 보고한다. 복구는 이 환경 변수 연결 한 줄을 되돌리는 PR이다.
