# Fleet 기준선 스냅샷 - 2026-08-27

이 문서는 P0에서 값 노출 없이 확인한 조직 migration 기준선이다. GitHub code search 결과는
검색 index 기준 raw count이므로 enforcement 완료율이나 삭제 승인 근거로 사용하지 않는다.

## 확인된 상태

| 항목 | 확인값 | 판정 |
| --- | ---: | --- |
| GitHub repository | 40 | 38 active, 2 archived |
| active template | 1 | `starter-template-app` |
| 기본 branch 예외 | 1 | `dpti-app`의 default가 `develop` |
| organization custom property schema | 0 | zero-touch 등록용 schema 미구성 |
| `secrets: inherit` 검색 파일 | 109 | 최소 27개 repository, legacy 문서 포함 raw count |
| 중앙 workflow `@main` 검색 파일 | 88 | 27개 repository raw count |
| App Store config JSON | 20 | 중앙 import와 parity 대상 |
| AppsInToss config JSON | 11 | 중앙 import와 parity 대상 |
| credential catalog | 95 | 오류 0, 경고 9 |

`.github` 구현 기준 SHA는 `1bebdb3aadf15e9f2651d1ec0fe361615b9d6609`에서 시작했다.
Android builder는 Artifact Registry readback으로 다음 digest를 확인했다. 하지만 실제 pilot
script의 unsigned output 계약과 ReleaseCandidate attestation이 없으므로 이 digest들은 현재
실행 승인 근거가 아니다.

- RN: `sha256:d403dabbd03e97490b0f676bc65dc2f510119480c60815298e37fb1a12a6172f`
- Godot: `sha256:b2a9d7a849f1193f42a40864d8487401abb6dc54472fe010b31b2e84e7be2940`

GitHub action major ref는 각 공식 repository의 Git ref API로 full SHA를 확인해
[`workflow-bundle-source.yaml`](../../contracts/workflow-bundle-source.yaml)에 고정했다. Godot
Linux binary checksum은 공식 4.7.2 release asset digest로 확인했다.

## 아직 닫히지 않은 기준선

- 현재 GitHub token에 `read:project`가 없어 기존 `Seorilabs Fleet` Project 존재와 field를
  확인하지 못했다. 중복 Project를 만들지 않는다.
- `admin:org`가 없어 organization ruleset의 실제 enforcement와 required check를 읽지
  못했다. 권한을 우회하거나 ruleset을 Active로 변경하지 않는다.
- GitHub code search rate limit 도달 뒤 Google Play config와 남은 파일 inventory가
  중단됐다. rate reset 뒤 idempotent inventory를 재개한다.
- provider별 API, browser session, dedicated bot account, TOTP 등록 상태는 Auth Broker
  migration에서 공개 account/team ID만 사용해 별도 확인한다.
- catalog 경고 9건은 미해결 상태다. credential 이동·회전·삭제는 backup과 restore 검증 및
  사용자 승인 전까지 수행하지 않는다.

## 다음 readback

1. GitHub App에 필요한 최소 `read:project`와 ruleset read 권한을 승인받아 existing Project와
   Evaluate 상태를 읽는다.
2. search rate reset 뒤 config·workflow·SDK·custom HTTP 전체 inventory를 source SHA와 함께
   `DiscoveryObservation`으로 적재한다.
3. Backoffice import가 끝나면 legacy JSON과 signed resolved manifest를 같은 SHA에서 비교한다.
4. Backoffice snapshot을 공개키로 검증하는 ReleaseCandidate attestation, AAB signing 부재
   검증, 파일럿 두 repository의 build-only evidence가 모두 생기기 전에는 WorkflowBundle을
   `APPROVED`로 승격하지 않는다.
