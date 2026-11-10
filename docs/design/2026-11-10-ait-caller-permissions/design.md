# Godot AIT 호출부 권한 유지

상태: syous가 2026-11-10 대화에서 실패 보완안의 세 마켓 v1.2.1 통일을 승인했다. 기준은 2bf7204159ced1cb0de2644f00485736bfea2173이며 제품 출시 범위는 Bloomhand #103에서 관리한다.

Bloomhand 실행42637996141은 caller의 actions: read가 callee의 contents: read 재선언으로 사라져 CI_RUN_UNVERIFIED로 중단했다. 재사용 workflow의 permissions 재선언을 제거해 caller의 권한을 유지한다. 직접 호출부8개의 실제 기본 브랜치를 조회했으며 모두 읽기 범위였다. 새 actions 권한을 중앙에서 강제하면 이를 선언하지 않은 기존5개 호출부가 깨질 수 있어 상속을 택했다.

흐름: caller 최소 권한 → callee 상속 → exact-SHA CI 조회 → 기존 개발 증거 검증 → 빌드/테스트 업로드. 조회 실패는 계속 실패이며 검증기·runner·Secret·계정·다른 앱 caller는 변경하지 않는다. 새 제품 화면·데이터·SDK 변경은 없다. 복구는 이 변경을 일반 PR로 되돌리는 것이며 태그나 키를 바꾸지 않는다.

검증은 L1/dev: 기존 실제 실패 로그를 red로 보존하고 npm ci/test, pack:check, actionlint와 diff 검사를 실행한다. 단순 permissions 삭제를 복제한 테스트 대신 실제 Bloomhand 새 실행의 Actions read 토큰과 같은 CI 조회 성공을 통합 인수조건으로 삼는다. 제품 실행 기록을 중앙 테스트로 꾸미지 않는다. 중앙 변경 자체는 마켓 배포가 아니며 Bloomhand의 전체18기능 L3 CI와 마켓 gate는 별도다.

인수조건: 기존 contents read 소비자를 깨지 않고 Bloomhand actions read를 유지한다. required check와 로컬 코드 리뷰 후 병합한다. 실제 AIT 배포 실행에서 CI_RUN_UNVERIFIED가 해결됐는지 확인한다. 다른 마켓 상태와 최초 AIT SDK 검증을 통과로 승격하지 않는다.

실행 티켓: [#322](https://github.com/seorilabs/.github/issues/322). 원본 호출부 감사와 실패 로그는 Bloomhand NAS1dual의 `2026-11-10/9b80c045c826cd1b883965e53ede029db6a0c714/pipeline-fix-proposal-followup` 및 `v1.2.0-attempt-before-fixes`에 보존한다.
