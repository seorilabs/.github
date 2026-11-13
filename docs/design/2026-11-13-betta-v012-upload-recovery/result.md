# 0.1.2 내부 채널 제공 결과

제품 후보는 `a65470d2a67308d808a8a8f63583aa1e14cc435e`, 태그는 `v0.1.2`다. Care와 조명, 소환, 번식 화면의 주요 버튼이 잘리는 문제를 수정한 동일 후보를 두 채널에 제공했다. 실제 렌더 40조건의 400시나리오와 CI 58여정이 통과했다. UI 코드는 `479d9c7` 이후 바뀌지 않았다.

| 채널 | 실제 조회 결과 |
|---|---|
| Google Play | `com.seorilabs.bettaraising`, 0.1.2 / code 3, `internal completed` |
| AAB 동일성 | 공급자 SHA-256이 `136e213a636c534d53f5ded35b911b6127039478e35dec8b01c8ac0ffbde7c77`과 일치 |
| 기존 Play code 1 | `generatedapks.list(versionCode=1)`에서 기존 APK 그룹 1개를 조회함 |
| TestFlight | 앱 `6834215464`, 0.1.2 / build 4, `VALID / IN_BETA_TESTING` |
| 내부 그룹 | `fe2b5b03-483c-4f0a-ba37-4cc1ec80452f`, 기존 테스터 1명, 한국어·영어 노트 GET 일치 |
| Apple delivery | `8bba90b0-1e8b-474e-a707-19272760e992` |

이번 네이티브 빌드는 각 1회 실행해 누적 Android 3회, Apple 4회가 됐다. 원래 작업트리 검사와 후처리의 실패 기록은 보존했다. 사용자가 `653f2c0` 복구안을 승인한 뒤 기존 서명 산출물만 사용해 추가 빌드 0회, 마켓별 접수 1회로 제공을 마쳤다. 제품 QA의 `THREE_UI_ROUNDS_REQUIRED`와 독립 UI, 성능, 네이티브 QA 미완료 상태는 유지한다. 기기 사용, 게임 main 반영, 심사 제출, 공개 출시, 새 자격증명 생성은 수행하지 않았다.

복구 코드 PR #355의 로컬 리뷰는 `timeout`, 허용된 재실행은 `limit_exceeded`로 완료하지 못했다. 정책의 대체 절차에 따라 사유와 자체 점검, 전체 테스트 2,087개 및 CI 통과를 기록했다. Google 헤더 수정 PR #357은 로컬 리뷰, HTTP 415 재현, 실제 로그 해시 대조, 전체 테스트 2,088개 및 CI를 통과했다. 승인 메타데이터 연결과 회수에는 `release-metadata-only-change` 예외를 적용했다. 두 채널 제공을 확인한 뒤 이 변경에서 남은 Google 승인도 회수한다. Cloud workflow는 실패 종료 후 비활성화 상태다.

## 증적

NAS1dual `/Volumes/Data/Backup/agent-artifacts/betta-raising/2026-11-13/a65470d2a67308d808a8a8f63583aa1e14cc435e/` 아래 각 `VERIFIED.json`에 파일별 크기와 SHA-256 재읽기, 파일 목록 검증을 기록한다.

- `candidate-validation-20261113T220700+0900`: 309개, 94,385,218바이트, manifest `4de18cdcfeb0815231384d4f3dcf4470dbe9b7f34ae34f3cad837c9950a95c43`
- `activation-review-20261113T221400+0900`: 20개, 9,034,540바이트, manifest `39c1661db66321d8cd44072d6dc34fdd130130b3883e4d1137038f8e938d98b8`
- `native-failures-20261113T230000+0900`: 62개, 235,046,905바이트, manifest `468fd0a2216446cf7aac2a4db1da875947046888524c9331a5b4165f387728d6`
- `delivery-proof-20261113T233300+0900`: 접수, 처리, 내부 제공, 노트, 최종 승인 회수 기록. 최종 검증값은 `VERIFIED.json` 참조

로컬 `build/internal-update-status.md`는 요약이며 원본은 NAS 복사 검증 뒤 정리한다. Play의 `edits.bundles`는 현재 edit의 bundle 목록이다. 새 code 3 반영 후 code 1이 목록에 없는 것을 삭제로 판단하지 않고 별도 `generatedapks` API로 기존 버전을 조회했다. 기존 bundle을 삭제하는 요청은 하지 않았다.
