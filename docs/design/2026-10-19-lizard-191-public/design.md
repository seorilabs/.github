# Lizard Tycoon 1.9.1 Android 공개 연결

[사용자 승인](https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549)은 정렬 보정 포함 후보 `da203979846fdcf4fb5b591689d776d84fe14911`, Google Play, v1.9.1의 빌드와 내부 업로드, 프로덕션 완전 출시 한 건이다. 승인 제안 hash와 원문은 위 기록에 있다. 다른 마켓, 기기, 새 독립 UI 회차와 근거 유효기간 연장은 포함하지 않는다.

기존 v1.9.0 L3 문서는 당시 source SHA, 실패와 마지막 6차 통과를 그대로 보존한다. 1.9.1의 L1 보정 문서는 새 후보의 실제 전체 CI113개를 사용한다. 두 문서를 별도 정상 검증한 후, 과거 문서의 정확한 세 FEATURE_COVERAGE 실패만 사람이 승인한 예외로 연결한다. 과거 실행 SHA를 새 후보로 고치거나 마지막 독립 회차를 작성자 검수로 대체하지 않는다.

전용 봉투 `kind: lizard-191-public-continuation`에는 원본 L3 문서와 새 v2 보정 문서를 넣고 전체 내용을 중앙 grant의 SHA-256으로 결속한다. 기본 v1과 v2 validator는 바꾸지 않는다. 전용 처리에서도 두 문서의 정상 검증을 먼저 실행하고, 보정 문서에 새 오류가 있거나 과거 문서의 오류가 원래 세 건과 다르면 종료한다. 최종 결과는 `human_exception`, `originalVerdict.ok=false`와 원래 오류를 보존한다.

중앙 grant는 앱, 후보 SHA, v1.9.1, google-play, 기존 만료 `2026-10-26T03:59:05Z`와 승인 근거를 고정한다. before-build, before-deploy의 internal/upload, before-release의 production/promote만 허용한다. 배포비율은1이다. CLI나 환경변수로 grant를 추가할 수 없다. 등록 누락, 만료와 중복은 차단한다.

Editor 원본은 실제 실행한 PR HEAD `001a8d9bec627c3d73ac8d258e0fb733202a38db`를 유지한다. GitHub에서 그 커밋과 후보의 tree가 같은지, 공개된 GitHub v1.9.1 Release의 동일 ZIP 자산655801246의 SHA-256이 원본과 같은지 조회해 연결한다. 등록 후보는 일반 L1 문서로 봉투를 우회하지 못하게 원격 Release 경로에서 차단한다. 기록된 홈 입력의 실패1회와 후속 통과, bootstrap 실패도 ZIP에 남긴다. 현재 제품 코드와 검수 데이터는 수정하지 않는다.

L1 개발 검증은 정상 증거의 기존 동작 보존, 허용 경로3개, 잘못된 앱과 SHA, tag, 마켓, 트랙과 operation, 누락 값, 만료, 원본과 보정의 변조, 추가 오류, 과거 마지막 실패, tree와 ZIP 불일치를 검사한다. 실제 비공개 근거로 원격 CLI의 세 단계를 확인하고 전체 중앙 테스트와 pack 검사, Claude 읽기 전용 교차 리뷰, PR CI 후 병합한다. 공개 완료 뒤 이 후보의 grant와 전용 분기를 제거한다.
