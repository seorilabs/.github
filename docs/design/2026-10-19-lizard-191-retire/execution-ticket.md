# 실행 티켓

- 후속 범위: #283의 승인 설계에 명시된 공개 후 제거.
- 승인 근거: https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549
- main 반영 조건: Google Play 제출36의 출시와 한국, 미국의 공개1.9.1 확인.
- 실행 전: 1.9.1 항목이 registry에서 사라져야 한다는 검사부터 실패를 확인했다.
- 검증: 전체 회귀와 패키지 검사, 원래 정상 검증기와 파일 내용 비교, PR CI와 교차 리뷰. 결과는 PR에 보존한다.
- 원본 실행 근거와 1.9.0 grant는 삭제하거나 바꾸지 않는다.

## 공개 조건 확인

Google Play 제출36은2026-10-19 19:13 KST에 출시됐다.10:13:59 UTC Console 재조회에서 출시됨을 확인했고,10:15:51 UTC 한국과 미국의 비로그인 공개 HTML에서 모두1.9.1과 새 출시노트의 정확한 문구를 확인했다. [공개 영수증](https://github.com/seorilabs/lizard-tycoon/releases/download/v1.9.1/android-191-public-readback.json)의 SHA256은 `13dc1ca06c52322df6b20a0d6987e315c199b15cfb63e9b1b2dff5335c48e439`, GitHub asset ID는655928425다. 제품 SHA와 versionCode1001004042를 유지했다. 이 PR의 공개 후 반영 조건이 충족됐다.

정상 검증기 blob은 예외 도입 전과 같은 `0541e1587818ab6cf72055b6901f915974338c26`이며, 실제 원격 봉투 CLI는 제거 후보에서 EVIDENCE_SCHEMA로 거부됐다. 최종 CI와 미해결 리뷰 확인 뒤 병합하고 원격 main에서 같은 거부를 확인한다.
