# 릴리즈 버전 authority caller 이관

중앙 정본 변경은 [`seorilabs/.github`](https://github.com/seorilabs/.github)에 이미 들어가 있다.
이 문서는 각 caller 저장소에서 **무엇을 기계적으로 바꿔야 하는지**만 다룬다. 실제 저장소별 PR
생성(fan-out)은 별도 단계이며, 이 문서와 계약을 입력으로 쓴다.

- 기계 판독 정본: [`contracts/release-version-authority-migration.yaml`](../../contracts/release-version-authority-migration.yaml)
- 결과 schema: [`contracts/release-version-authority-migration.schema.json`](../../contracts/release-version-authority-migration.schema.json)
- version 정본: [`contracts/release-version-authority.yaml`](../../contracts/release-version-authority.yaml)

## 인벤토리 수집

저장소를 수정하지 않고 읽기만 한다. **기본 소스는 GitHub의 default branch tip이다.**

```bash
# 저장소 하나
GITHUB_TOKEN=... node scripts/release/collect-caller-migration-inventory.mjs seorilabs/<repo> \
  --expected-central-sha <중앙 merge commit 40hex>

# 조직 전체
GITHUB_TOKEN=... node scripts/release/collect-caller-migration-inventory.mjs --fleet \
  --expected-central-sha <40hex> \
  --repositories-from contracts/autonomous-issue-policy.yaml \
  --out docs/migration/evidence/release-version-ledger-caller-fleet-<날짜>.json
```

로컬 복제본을 읽으려면 `--source filesystem`을 준다. 다만 복제본이 원격과 어긋나면
`stale-working-tree`로 막는다. 실측 예로 `seorilabs/lord-ledger`의 로컬 clone은 `9afa357f`를,
원격 main은 `565fba53`을 가리키고 있었다. 그 상태로 판정하면 "이미 이관됐다"거나 "아직 안 됐다"를
자신 있게 틀리게 말한다.

기대 중앙 SHA는 계약에 박지 않고 실행 시 주입한다. 중앙 merge commit SHA는 그 계약을 담은 커밋
이후에만 확정되므로 계약 상수로 두면 순환한다.

출력은 위 schema를 만족하는 JSON이고 `status`가 `NEEDS_CHANGE`면 `findings`의 `blocking`
항목이 남아 있다는 뜻이다. 이 결과만 보고 저장소별 변경을 만든다.

### fleet 요약

`--fleet` 출력은 모든 저장소를 `MIGRATED` / `PENDING` / `EXCLUDED` 중 하나로 분류한다.
`EXCLUDED`의 사유는 자유 서술이 아니라 고정 enum이다.

| 사유 | 뜻 |
|---|---|
| `no-central-caller` | 중앙 재사용 워크플로를 호출하지 않는다 |
| `no-central-release-tag-caller` | 마켓 caller는 있는데 `release-tag` caller가 없어 원장을 채울 수 없다 |
| `archived-repository` | 보관된 저장소 |
| `no-market-release-target` | 마켓 배포 대상이 아니다 |
| `blocked-awaiting-provider-readback` | 기준 번호 확보 대기 |
| `human-hold` | 사람이 의도적으로 보류 |

## caller 종류별 기계적 변경

| caller kind | 제거 | 추가·확인 |
|---|---|---|
| `rn-deploy-google-play` | `version_name`, `version_code`, `version_script`, repo-local uploader | exact 중앙 SHA의 업로더가 검증된 AAB만 업로드 |
| `godot-deploy-google-play` | 같음 + `runs_on`, repo-local uploader | preset 이름이 `Android`가 아니면 `android_export_preset` 명시. 중앙 direct export로 표현할 수 없으면 `build_script`가 `SEORI_RELEASE_*`를 읽고 `SEORI_ANDROID_AAB_OUTPUT`에만 쓴다. 러너는 `seorilabs-x64-android`로 중앙 고정 |
| `rn-deploy-ait` / `godot-deploy-ait` | 같음 | 저장소 `deploy` 스크립트가 `--memo`와 `--location`을 **그대로** 전달(memo에 artifact sha256이 들어감) |
| `release-tag` | `runs_on` | 러너는 `seorilabs-rpi-arm64`로 중앙 고정. **`init-release-version-ledger` caller가 함께 있어야 한다** |
| `init-release-version-ledger` | — | 저장소당 한 번. `release-tag` caller 없이는 의미가 없다 |
| `record-ios-build-observation` | — | 선택. `ios` 구획만 갱신하고 Android 번호를 소비하지 않는다 |
| `promote-google-play` | — | 업로드 도구가 `--promote-version-code`를 수용하고 그 build만 승격 |

`uses:`는 모두 40자리 commit SHA로 고정한다. `@main`, `@v1` 같은 floating ref는 이관 대상이
아니라 즉시 결함이다. config revision을 고정할 수 없기 때문이다.

## 저장소에서 제거하는 version authority

- `scripts/resolve-release-version.mjs`
- `play-store/google-play.config.json`의 `release.versionName`, `release.versionCode`
- `app-store/app-store.config.json`의 `release.version`

`play-store/google-play.config.json`의 `packageName`은 제거하지 않는다. authority가 아니라 provider
readback 대상 식별자다.

값이 필요하면 중앙이 결정한 값을 **주입**하고, build 후 artifact에서 다시 읽어 대조한다.

## 원장 선행 조건

`release-tag.yml`은 원장이 없으면 `ledger-missing`으로 멈춘다. caller PR을 머지하기 전이나 직후에
[원장 초기화](release-version-ledger-initialization.md)를 끝내야 한다. 기준 번호는 추측하지 않는다.

## 완료 판정

아래를 모두 만족해야 이관 완료로 본다. 하나라도 미충족이면 완료로 보고하지 않는다.

1. 모든 caller `uses`가 exact commit SHA로 고정됐다.
2. caller에 `version_name`, `version_code`, `version_script`가 없다.
3. exact 중앙 SHA의 마켓 업로드 도구가 `--aab-path`로 받은 파일만 올리고, `SEORI_EXPECTED_AAB_SHA256`과
   `SEORI_EXPECTED_ANDROID_VERSION_CODE`를 필수로 요구한다.
4. build script가 `SEORI_RELEASE_*` 환경변수를 읽어 주입한다.
5. exact stable 태그 실행에서 artifact readback이 통과한다.
6. 모든 caller `uses`가 이관 후 확정된 중앙 merge commit SHA로 고정됐다.
7. `refs/heads/release-version-ledger`가 있고 tip JSON이 원장 schema를 통과한다.
8. `provenance.baseline.sources`가 검증된 소스를 하나 이상 담고 추정값이 없다.
9. 원장 브랜치와 `refs/tags/v*`를 덮는 org ruleset이 active이고 `bypass_actors`가 비어 있다.
10. fleet 요약의 모든 저장소가 `MIGRATED`이거나 고정 enum의 `exclusionReason`을 갖는다.

빌드 성공은 업로드 완료가 아니고, 업로드 성공은 공개 출시가 아니다. 상태를 구분해 보고한다.
