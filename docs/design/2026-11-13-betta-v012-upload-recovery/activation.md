# 고정 산출물의 업로드 승인 연결

사용자가 승인한 제안653f2c0과 코드PR355/1caee4ff8245f45423e0bc3c6a4eef5711749891을 고정한다. 새 native는0회이며 기존 AAB와 App Store IPA의 접수만 마켓별1회 허용한다. 이전 두 정상 업데이트 grant는 회수됐고 Cloud workflow는 비활성화 상태다.

제품source a65470d2a67308d808a8a8f63583aa1e14cc435e,태그v0.1.2,원장code3,CI43427192956/58여정과 서명을 유지한다. Google3회/Apple4회의 실제 native 이력·원래 before-build claim·실패 로그 및 provider artifact를 검사한다. 원래 작업트리·후처리 실패와 THREE_UI_ROUNDS_REQUIRED/blocked를 통과로 바꾸지 않는다.

두 grant는 검토한 schema의 고정 artifact binding만 담는다. Google AAB SHA-256은136e213a636c534d53f5ded35b911b6127039478e35dec8b01c8ac0ffbde7c77,IPA는188b36af4f7490fc85a7b82355af8efd9378b7e3c06b6f6bc697f1efe8ce485e다. 원래18개 관측과 새 실패2개를 모두 고정한다. 추가 승인 파일은 검토한 code revision의 approval.json/digest로 읽는다. package/version 원자적 업로드 예약과 늦은 producer 차단을 쓰고 접수 불명 시 재시도하지 않는다.

검증은 schema·원래 scope/fingerprint 동일성·승인 digest·원래 마켓 baseline 및 실제 실행 이력 대조로 한다. 이 PR은 이미 검토한 코드에 고정 릴리스 승인 데이터와 등록 경로만 연결한다. 새 코드나 설정 로직은 없으므로 review-policy의 release-metadata-only-change 예외에 해당한다. codePR355의 로컬 리뷰는 timeout 및 재실행 limit_exceeded로 결과를 받지 못했으며, 정책 fallback과 자체점검·전체2,087개/CI 통과 근거를 PR355에 기록했다.

기기·게임 main·심사·공개·새 credentials/유료 플랜은 제외한다. 기존 만료2026-11-19T15:35:59.411730+00:00은 연장하지 않는다. 접수 후 Play internal completed와 TestFlight VALID/내부 그룹 제공을 실제 조회하고 grant를 회수한다.
