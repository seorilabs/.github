# 0.1.2 내부 채널 제공 결과

제품source는a65470d2a67308d808a8a8f63583aa1e14cc435e,태그v0.1.2다. Care와 조명·소환·번식 주요 버튼의 잘림을 수정한 동일 후보를 제공했다. 실제 렌더40조건400시나리오와 CI58여정이 통과했다. source의 UI 코드는479d9c7 이후 바뀌지 않았다.

| 채널 | 실제 조회 결과 |
|---|---|
| Google Play |com.seorilabs.bettaraising,0.1.2/code3,internal completed|
| AAB 동일성 |provider sha256이136e213a636c534d53f5ded35b911b6127039478e35dec8b01c8ac0ffbde7c77과 일치|
| 기존 Play code1 |generatedapks.list(versionCode1)에서 기존 APK group1개를 조회함|
| TestFlight |app6834215464,0.1.2/build4,VALID/IN_BETA_TESTING|
| 내부 그룹 |fe2b5b03-483c-4f0a-ba37-4cc1ec80452f,기존 tester1명,한국어·영어 노트 GET 일치|
| Apple delivery |8bba90b0-1e8b-474e-a707-19272760e992|

이번 native는 각1회 실행해 누적 Android3/Apple4가 됐다. 원래 작업트리 검사와 후처리는 실패했고 그 실패를 그대로 보존했다. 사람의653f2c0 복구안 승인으로 동일 서명 산출물만 사용해 추가 native0회·접수1회/마켓으로 완료했다. 정상 제품QA의 THREE_UI_ROUNDS_REQUIRED와 독립 UI·성능·native 미완료는 유지한다. 새 자격증명·기기 사용·게임 main 반영·심사·공개는 수행하지 않았다.

복구 코드PR355의 로컬 리뷰는 timeout 및 허용된 재실행 limit_exceeded로 unavailable이었다. 정책 fallback으로 사유와 자체점검·전체2,087개/CI 통과를 기록했다. Google 헤더 수정PR357은 로컬 리뷰와 HTTP415 재현/실제 로그 digest 대조·전체2,088개/CI를 통과했다. 승인 메타데이터 연결·회수에는 release-metadata-only-change 예외를 적용했다. 전 마켓 제공 확인 후 남은 Google grant도 회수한다. Cloud workflow는 실패 종료 뒤부터 비활성화 상태다.

## 증적

NAS1dual `/Volumes/Data/Backup/agent-artifacts/betta-raising/2026-11-13/a65470d2a67308d808a8a8f63583aa1e14cc435e/` 아래 각 VERIFIED.json이 파일별 크기·SHA-256 재읽기와 payload 목록 검증을 담는다.

- `candidate-validation-20261113T220700+0900`:309개94,385,218B,manifest4de18cdcfeb0815231384d4f3dcf4470dbe9b7f34ae34f3cad837c9950a95c43
- `activation-review-20261113T221400+0900`:20개9,034,540B,manifest39c1661db66321d8cd44072d6dc34fdd130130b3883e4d1137038f8e938d98b8
- `native-failures-20261113T230000+0900`:62개235,046,905B,manifest468fd0a2216446cf7aac2a4db1da875947046888524c9331a5b4165f387728d6
- `delivery-proof-20261113T233300+0900`:접수·처리·내부 제공·노트와 최종 회수 기록. 최종 검증값은 VERIFIED.json 참조

로컬 build/internal-update-status.md는 요약이며 원본은 NAS 복사 검증 뒤 정리한다. Play의 edits.bundles는 현재 edit의 bundle 목록이므로 새 code3 반영 후 code1이 목록에 없어도 삭제로 판단하지 않았다. 별도 generatedapks API로 code1이 여전히 조회되는 것을 확인했다. 기존 bundle을 삭제하는 요청은 하지 않았다.
