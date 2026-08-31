# 릴리즈 버전 authority caller 이관

중앙 정본 변경은 [`seorilabs/.github`](https://github.com/seorilabs/.github)에 이미 들어가 있다.
이 문서는 각 caller 저장소에서 **무엇을 기계적으로 바꿔야 하는지**만 다룬다. 실제 저장소별 PR
생성(fan-out)은 별도 단계이며, 이 문서와 계약을 입력으로 쓴다.

- 기계 판독 정본: [`contracts/release-version-authority-migration.yaml`](../../contracts/release-version-authority-migration.yaml)
- 결과 schema: [`contracts/release-version-authority-migration.schema.json`](../../contracts/release-version-authority-migration.schema.json)
- version 정본: [`contracts/release-version-authority.yaml`](../../contracts/release-version-authority.yaml)

## 인벤토리 수집

저장소를 수정하지 않고 읽기만 한다.

```bash
node scripts/release/collect-caller-migration-inventory.mjs <저장소 경로> \
  --full-name seorilabs/<repo>
```

출력은 위 schema를 만족하는 JSON이고 `status`가 `NEEDS_CHANGE`면 `findings`의 `blocking`
항목이 남아 있다는 뜻이다. 이 결과만 보고 저장소별 변경을 만든다.

## caller 종류별 기계적 변경

| caller kind | 제거 | 추가·확인 |
|---|---|---|
| `rn-deploy-google-play` | `version_name`, `version_code`, `version_script`, repo-local uploader | exact 중앙 SHA의 업로더가 검증된 AAB만 업로드 |
| `godot-deploy-google-play` | 같음 + `runs_on`, repo-local uploader | preset 이름이 `Android`가 아니면 `android_export_preset` 명시. 중앙 direct export로 표현할 수 없으면 `build_script`가 `SEORI_RELEASE_*`를 읽고 `SEORI_ANDROID_AAB_OUTPUT`에만 쓴다. 러너는 `seorilabs-x64-android`로 중앙 고정 |
| `rn-deploy-app-store` | 같음 | — |
| `godot-deploy-app-store` | 같음 | `ios_export_preset`이 실제 export 대상 preset 이름과 같아야 함 |
| `rn-deploy-ait` / `godot-deploy-ait` | 같음 | 저장소 `deploy` 스크립트가 `--memo`와 `--location`을 **그대로** 전달(memo에 artifact sha256이 들어감) |
| `release-tag` | `runs_on` | 러너는 `seorilabs-rpi-arm64`로 중앙 고정 |
| `promote-google-play` | — | 업로드 도구가 `--promote-version-code`를 수용하고 그 build만 승격 |
| `rn-build-android` | 같음 | — |
| `ait-build-only-v1` (v5 정본) | caller 입력 **전체** | `scripts/build-ait.sh`가 `SEORI_RELEASE_TAG`, `SEORI_RELEASE_VERSION`을 읽어 주입 |
| `rn-build-android-cloud-v2` / `godot-build-android-cloud-v2` (v5 정본) | caller 입력 **전체** | `scripts/build-android.sh`가 `SEORI_RELEASE_VERSION_NAME`, `SEORI_RELEASE_VERSION_CODE`를 읽어 주입 |

`uses:`는 모두 40자리 commit SHA로 고정한다. `@main`, `@v1` 같은 floating ref는 이관 대상이
아니라 즉시 결함이다. config revision을 고정할 수 없기 때문이다.

## 저장소에서 제거하는 version authority

- `scripts/resolve-release-version.mjs`
- `play-store/google-play.config.json`의 `release.versionName`, `release.versionCode`
- `app-store/app-store.config.json`의 `release.version`

값이 필요하면 태그 파생값을 **주입**하고, build 후 artifact에서 다시 읽어 대조한다.

## 완료 판정

아래를 모두 만족해야 이관 완료로 본다. 하나라도 미충족이면 완료로 보고하지 않는다.

1. 모든 caller `uses`가 exact commit SHA로 고정됐다.
2. caller에 `version_name`, `version_code`, `version_script`가 없다.
3. exact 중앙 SHA의 마켓 업로드 도구가 `--aab-path`로 받은 파일만 올리고, `SEORI_EXPECTED_AAB_SHA256`과
   `SEORI_EXPECTED_ANDROID_VERSION_CODE`를 필수로 요구한다.
4. build script가 `SEORI_RELEASE_*` 환경변수를 읽어 주입한다.
5. exact stable 태그 실행에서 artifact readback이 통과한다.

빌드 성공은 업로드 완료가 아니고, 업로드 성공은 공개 출시가 아니다. 상태를 구분해 보고한다.
