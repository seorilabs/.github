# UI5 승인 timestamp 보정 검증

- 설계 보충 커밋:4eed1ed, 기준 main729f4d975014e97e7ff5e4a687327bc5261b0d1f. 기존 UI6 중앙 최소 보정·원문 보존 승인 범위다.
- 실제 canonical UI5 approvalRecordedAt `2026-10-14T10:56:24.262911+00:00`과 원문 hash7c5029587d363c4d42d1a1444f298292eeadae9bc558bf3bc5473fdb4c69e795를 직접 읽어 사용했다. 전체 fixture는 합성 단위 테스트이며 실제 제품 실행 근거가 아니다.
- RED112개 중110통과/2실패: 기존5회/6회 모두 같은 fractional bytes의 Z 표현을 TESTFLIGHT_UI5_EDITOR_APPROVAL로 거절했다. 문법·환경 오류가 아니다.
- 프로덕션 변경은 UI5 승인 연결 비교1줄뿐이다. 끝 +00:00만 Z로 변환한다. Date.parse 변환·fraction 절삭·schema/원문/승인시각/기한/회차/검수 정책 변경이 없다.
- GREEN112/112, 중앙 전체588/588, npm run pack:check, git diff --check 통과.
- 다른 초·마이크로초 한 자리 차이·fraction 밀리초 절삭·fraction trailing byte 추가·같은 instant의 다른 offset은 계속 UI5_EDITOR_APPROVAL로 거절한다. 기존 Z 경로 회귀도 통과했다.
- 기존 approval/proposal 디렉터리와 계약/schema/정책·grantRegistry는 변경하지 않았다. 실제 grant·번호·태그·빌드·업로드는0이다.
- 부모의 exact diff 검토 전 PR·외부 전송·리뷰 요청·push를 수행하지 않았다. 기존 PR252의 리뷰2/2를 재사용하거나3차 리뷰를 붙이지 않는다.

## 보존 출력

- sgd-central-ui5-timestamp-red.log SHA256 `41aa0da66ceadaaaa333210a60c7f19414fe3f7c6ffc4c681a3ff17977572408`
- sgd-central-ui5-timestamp-green.log SHA256 `8b0f4e94b846f62c6437c755dd5467e36c69c9dfcbf65d75dbe00ef710f50175`
- sgd-central-ui5-timestamp-full-test.log SHA256 `39886bff919e2867e52a805ea2bf73aa107c7feb8de5fcc3d3c0919e6d8cb9ae`
