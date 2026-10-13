# Reascend iOS 1.1.1 후보 예외

- 상태: 사람 승인 후 구현. 원문 승인: “Android 1.1.0·iOS 1.1.1 전환 설계 승인 (권장)”.
- 범위: Android `v1.1.0`/versionCode 21/심사 제출 4는 유지하고 iOS만 `v1.1.1`로 진행한다.
- 원인: Xcode Cloud 빌드 17의 `/var` 심볼릭 링크 prefix에서 npm workspace 해석이 lock과 어긋난다. 같은 중앙 package/lock을 실제 경로에서 설치하면 성공한다. Apple은 `TMPDIR` 설정을 시스템 예약 변수라 거절했다.
- 앱 수정: [Reascend PR #512](https://github.com/seorilabs/reascend/pull/512)의 임시 폴더 실제 경로 정규화. 중앙 SHA·압축 파일 해시는 이 전용 grant가 병합된 최종 커밋으로 연결한다. 기존 버전 발급 helper는 보존한다.
- 중앙 변경: 전용 app-store grant·승인·관찰 파일과 등록 목록만 추가한다. 기존 1.1.0 grant 및 일반 검증·철회·산출물·실제 CI 입력 검증은 유지한다.
- 사용자 흐름·인터페이스·저장 형식: 제품 변경 없음. 최소 1.1.0 결제 노출·기존 가격·보너스·한도·광고 OFF를 유지한다.
- 근거: 기존 26기능 판정과 원본 관찰 파일의 bytes·위험·기준 제품 tree를 보존한다. 원래 승인 시각의 168시간 만료를 연장하지 않는다. 새 후보에 source SHA·설정 지문·공식 태그를 다시 결속한다.
- 검증: 새 grant가 Android 또는 1.1.0 태그를 허가하지 않는지, 원래 만료 이후나 원본 근거가 없을 때 거절하는지 확인한다. 실제 CI before-build와 before-deploy를 별도로 검증한다.
- 실행 승인: 앱·중앙의 제한된 diff를 Claude 읽기 전용 리뷰로 각각 1회 전송하고 CI·지적 처리 후 병합한다. 추가 1시간 Reascend contents-read 토큰 1회와 Cloud 빌드 1회를 사용한다. 추가 결제·UI·제품 E2E·Apple TEST는 수행하지 않는다.
- 운영: iOS 메타데이터·처리·심사·승인·수동 공개·국가 확대를 각각 기록한다. 각 마켓 새 버전 공개 이후에만 앱·젬의 요건 충족 국가를 함께 확대한다. 실패·미확인은 통과로 바꾸지 않는다.
- 복구: 사용 후 추가한 토큰 행만 제거하고 원래 7개 환경 변수의 보존을 재조회한다. 기존 태그를 이동하거나 다른 후보·마켓의 근거를 재사용하지 않는다. 준비·빌드 60분 상한이며 추가 청구는 없다.
- 추적: [Reascend 실행 이슈 #506](https://github.com/seorilabs/reascend/issues/506). 원문 설계·사람 응답의 비공개 원본은 공개 grant의 SHA-256으로 연결한다.

## 품질·대안·실패 조건

- 품질 제약: 기존 Android 준비 소스 `0ebc8b7`을 제품 비교 기준으로 고정하고, 후보는 Xcode 검증 hook만 바꿀 수 있다. Android workflow·SDK·기능 목록·데이터·저장·가격·권한은 같은 bytes와 모드를 유지한다. 원래 관찰 근거의 기준은 `0f6e2f8c`이며 갱신하지 않는다.
- 대안: Apple의 TMPDIR 설정은 예약 변수라 거절됐다. 기존 1.1.0 태그 재작성은 Android 심사 근거를 바꾸므로 제외했다. iOS 1.1.1의 영구 경로 수정과 전용 예외를 선택했다.
- 인터페이스: 명시적 예외 ID·마켓·tag/source/config/verifier SHA와 Release 원본을 기존 검증기에 전달한다. 잘못된 입력·최신 grant 철회·만료·원본 누락·제품 tree 변경·실제 CI 입력 불일치·서명 앱 버전/번호 불일치는 오류로 종료하고 해당 phase 보고서를 보존한다. 앱 UI·공개 API·원장 형식 변경은 없어서 새 사용자 흐름/데이터 설계는 해당하지 않는다.
- 인수조건: before-build의 생성 runtime과 1.1.1 실제 입력 대조 성공; before-deploy의 소비 runtime·binding·실제 CI 번호·서명 앱 plist 대조 성공; Android workflow 변경·구 tag 입력·철회·잘못된 build 번호·잘못된 앱 버전의 거절. `tests/release-exception.test.mjs`의 iOS111 전체 검증기 fixture로 확인한다. 외부 응답/plutil은 단위 테스트 경계의 대체이며 실제 배포 근거는 별도 Cloud phase에서 요구한다.
