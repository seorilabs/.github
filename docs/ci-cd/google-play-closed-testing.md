# Google Play 폐쇄 테스트 운영

## 기준과 계정 확인

2023-11-13 이후 생성한 개인 개발자 계정의 신규 앱은 앱별로 최소 12명이 폐쇄 테스트에 연속 14일 참여 신청 상태여야 프로덕션 접근을 신청할 수 있다. 내부 테스트, 그룹 회원 수, AAB 업로드, 테스트 링크 발급은 이 요건의 증거가 아니다. Google이 신청 시 실제 사용·피드백·수정 내용을 묻는다. 최종 기준은 해당 앱의 Play Console 대시보드다.

시작 전에 Chrome의 대상 프로필에서 Google 로그인, 선택된 개발자 계정 이름·유형·ID, 앱의 실제 소유 계정과 패키지, 폐쇄 테스트 상태를 읽는다. 이미 다른 계정에 등록된 패키지는 새 계정에서 다시 만들지 않는다. 계정 소유권이 불명확하면 그룹을 연결하거나 출시 상태를 변경하지 않는다.

## 그룹과 모집

- 서리랩스 **전체 그룹**은 테스터 모집과 공통 공지에 쓴다. 실제 사람 16~20명을 모집하고 전체 프로그램 참여에 동의한 사람만 등록한다. 본인의 추가 Google 계정은 설치·계정 전환 QA에 쓰되 12명 계획에는 넣지 않는다.
- **앱별 그룹**은 해당 앱의 폐쇄 테스트 접근에만 쓴다. 전체 그룹에서 앱 참여를 모집한 뒤 해당 앱에 별도로 동의하고 승인된 사람만 앱별 그룹에 등록한다. 전체 그룹을 앱별 그룹에 중첩하거나 Play 트랙에 연결하지 않는다.
- 첫 신규 앱에서 앱별 Workspace Google Group이 Play Console 폐쇄 테스트의 테스터 탭에 연결되는지 소수 계정으로 검증한다. Workspace 도메인 주소가 거부되면 그 앱에는 `@googlegroups.com` 그룹을 사용한다. Google 도움말은 이 형식을 안내하며, 비즈니스 그룹 API는 개인용 그룹을 관리하지 못한다.
- 그룹 가입자는 참여 링크에서 **직접 참여 신청**해야 한다. 내부 테스트에 참여 중인 계정은 먼저 내부 테스트에서 나와야 폐쇄 테스트를 받을 수 있다. 설치와 주요 기능 사용을 실기기에서 확인한다.
- 그룹 가입은 앱별 참여 신청이나 14일 유지의 증거가 아니다. 각 앱의 참여 링크·설치 안내·테스트 과제·피드백 채널은 해당 앱 승인자에게만 안내한다. 전체 그룹의 자동 환영 메시지는 공통 프로그램 범위만 설명한다.

## 중앙 도구

`scripts/release/manage-google-play-testers.py`는 Android Publisher API로 앱의 폐쇄 트랙 Google Group 주소를 읽고 추가한다. 기존 그룹은 보존하며 같은 주소를 재실행해도 변경하지 않는다. 기본은 읽기 전용이고 `--apply`일 때만 edit을 commit한다. 이 도구는 개인별 참여 신청 정보를 읽을 수 없다.

```bash
python3 scripts/release/manage-google-play-testers.py \
  --package-name com.example.app --track closed \
  --group-email example-app@googlegroups.com
# Console에서 그룹 호환성을 확인한 후에만 위 명령에 --apply를 붙인다.
```

중앙 `promote-google-play.yml`의 `closed_test_group_email` 입력은 내부 → 폐쇄 트랙 승격 전에 이 도구를 실행한다. **해당 앱의 그룹 주소만** 전달한다. 입력값은 앱별 운영 설정의 정본인 Backoffice `ConfigRevision` 또는 운영자의 명시적 dispatch에서 받아야 한다. 앱 저장소에 별도 운영 JSON을 만들지 않는다. 그룹 연결을 생략할 수 있는 기존 호출부와 호환된다. `--apply` 전에는 전체 그룹 주소와 다른지 확인하고, 이후 API 읽기 결과와 Console 테스터 탭을 대조한다.

Workspace 그룹을 사용하는 경우 `scripts/release/sync-workspace-testers.py`가 비공개 승인 CSV를 읽는다. 전체 그룹에는 `consentScope=seorilabs-play-portfolio` 승인자만 등록한다. 앱별 그룹에는 해당 전체 승인과 `consentScope=app:<Android 패키지명>` 승인이 모두 있는 사람만 등록한다. 다른 앱 동의만으로는 등록하지 않는다. 기본은 읽기 전용이고 `--apply`일 때만 등록한다. 회원 주소는 로그에 출력하지 않는다. 실행 계정은 대상 그룹의 소유자 또는 회원 관리 권한만 갖게 하고 도메인 전체 그룹 관리자 권한은 부여하지 않는다. 개인용 `@googlegroups.com` 그룹에는 이 API를 쓰지 않고 그룹 웹 화면에서 회원을 관리한다.

```bash
python3 scripts/release/sync-workspace-testers.py \
  --group-email testers@example.com --group-kind portfolio \
  --approved-csv /private/path/approved-testers.csv
python3 scripts/release/sync-workspace-testers.py \
  --group-email example-app-testers@example.com --group-kind app \
  --app-id com.seorilabs.example --approved-csv /private/path/approved-testers.csv
# 각 그룹의 실제 주소와 승인 기록을 확인한 뒤 해당 명령에 --apply
```

CSV는 저장소 밖에 두고 소유자만 읽고 쓰게 한다 (`chmod 600`). 열은 `email,consentScope,consentedAt,approvedAt,status`이며 날짜는 ISO 형식이다. 한 이메일과 동의 범위당 현재 상태 한 행을 유지한다. `status=approved`가 아닌 행은 등록하지 않는다. 승인 철회 시 그 행의 상태를 바꾸고 그룹 회원도 제거해야 한다. 이 도구는 **추가만** 하므로 제거는 운영자가 그룹에서 수행하고 재조회한다. 전체 그룹의 환영 메시지는 공통 프로그램 안내만 담당한다. 승인 없이 직접 추가하거나 자동 이메일 발송을 시작하지 않는다.

`scripts/release/audit-google-play-closed-test.py`는 운영자가 Console에서 확인해 별도로 기록한 날짜를 집계한다. 비공개 CSV 열은 `appId,personId,accountType,optedInAt,optedOutAt,consoleVerifiedAt,feedbackRecordedAt`이다. `accountType`은 `independent` 또는 `owner-qa`; `personId`는 한 사람의 여러 계정을 묶는 임의 식별자다. 이 집계의 `candidateForConsoleReview`는 Console 확인 대상을 뜻하며 프로덕션 접근 자격이나 승인을 확정하지 않는다. 참여 철회 후 재참여 시 새 행에 새 시작일을 기록한다.

```bash
python3 scripts/release/audit-google-play-closed-test.py \
  --app-id example-app --observations-csv /private/path/play-optins.csv
```

## 14일 운영과 완료 판정

1. 매일 그룹 등록 현황, Play Console 참여 신청 인원과 지속 기간, 피드백을 대조한다. 12명 미만 또는 피드백 부족이면 운영자에게 알리고 실제 참여자 보충·과제를 진행한다. 참여 링크 열람이나 그룹 회원 수로 빈 값을 채우지 않는다.
2. 오류·의견, 재현 조건, 수정과 재검증 결과를 앱별로 기록한다. 테스트 중 새 빌드를 배포해도 기존 참여 신청 상태가 유지되는지 Console에서 확인한다.
3. 최소 12명의 연속 14일과 실제 사용·피드백 근거가 확보되면 Play Console 대시보드에서 프로덕션 접근 신청 가능 상태를 읽고 신청서를 작성한다. 신청, Google 검토, 승인, 프로덕션 배포, 공개 설치를 각각 별도 상태로 기록한다.

공식 기준: [개인 개발자 계정 테스트 요건](https://support.google.com/googleplay/android-developer/answer/14151465), [테스트 설정](https://support.google.com/googleplay/android-developer/answer/9845334), [Play 테스터 API](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers), [Cloud Identity 그룹 API 범위](https://docs.cloud.google.com/identity/docs/groups).
