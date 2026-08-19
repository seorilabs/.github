# Seorilabs 빌드 툴체인 계약

> 상태: 설계 확정안(v1). 적용 대상: `seorilabs` org 전체.
> 작성 근거: 2026-08-20 org 전수 실측 — Google Play 배포 repo 17곳의 caller 방식·Godot/JDK 버전, `seorilabs/.github` 재사용 워크플로우 4종, Xcode Cloud 이관 repo 10곳.
> 마켓 배포의 **트리거·라우팅**은 [org CI/CD 릴리즈 시스템](org-cicd-release-system.md)이 정한다. 이 문서는 그 안에서 **빌드 자체가 어떻게 정의되고 어디서 실행되는가**를 정한다.
> 변경 시 이 문서 → 재사용 워크플로우 → 빌더 이미지 → 각 repo 순서로 반영한다.

---

## 0. 문제

같은 앱을 빌드하는 방법이 실행 위치마다 다르다.

- **로컬**에서는 개발자가 repo 스크립트를 직접 부르거나, 아예 재현할 방법이 없다.
- **CI**에서는 org 재사용 워크플로우가 툴체인 설치와 export를 자기 본문에 품고 있다.
- **Cloud Build**로 옮기려면 같은 빌드를 세 번째로 다시 쓰게 된다.

정의가 갈리면 "CI에서만 되는 빌드"와 "로컬에서만 되는 빌드"가 생기고, 실패를 재현할 수 없다.

### 이탈은 이미 일어나 있다

`godot-deploy-google-play.yml`은 워크플로우 본문에서 Godot을 내려받아 export까지 수행한다. 그래서 그 이상이 필요한 repo는 재사용 워크플로우를 **버리고** 인라인 caller로 갔다.

| repo | 엔진 | 이탈 사유 |
|---|---|---|
| lizard-tycoon | Godot | GodotGooglePlayBilling + custom gradle build template + AAB 모드 |
| lucid-chess | Godot | 문서화되지 않음 |
| crossword-puzzle | RN | 문서화되지 않음 |
| happy-farm | RN | 문서화되지 않음 |

이탈 자체가 문제가 아니라, **재사용 워크플로우가 빌드를 품고 있어서 확장 지점이 없다는 것**이 문제다. 특수 요구가 생기면 통째로 복사하는 것 말고 길이 없다.

### 버전도 갈려 있다

2026-08-20 실측. Godot 게임 10곳.

| Godot | repo |
|---|---|
| 4.6.3 | foam-party, lucid-reversi, starter-template-game, reascend, lizard-tycoon, lucid-chess |
| 4.7.1 | jomul, matgo, spiritgate-defenders, slotmachine-game |

재사용 워크플로우 기본값은 `4.6.3`인데 절반이 `godot_version`으로 덮고 있었다. `global-versions.yaml`의 기록과도 어긋났다.

---

## 1. 핵심 원칙

1. **빌드 정의는 repo 스크립트가 소유한다.** CI는 인증·시크릿·아티팩트 라우팅만 한다. 워크플로우 본문에 툴체인 설치나 export 명령을 두지 않는다.
2. **툴체인은 빌더 이미지가 제공한다.** 실행 위치(로컬·GitHub Actions·Cloud Build)가 달라도 같은 이미지를 쓴다. 매 실행마다 SDK·엔진을 내려받지 않는다.
3. **툴체인 버전은 repo에 한 번만 선언한다.** 워크플로우 입력, 스크립트 상수, 문서에 같은 버전을 중복해서 적지 않는다.
4. **엔진 버전은 org 전체가 하나로 수렴한다.** repo별 표류를 허용하지 않는다.
5. **Apple은 예외다.** Xcode Cloud가 macOS와 `ci_scripts` 규약을 강제하므로 그것이 진입점이다. 원칙 1은 그대로 적용된다 — `ci_scripts`가 빌드를 소유한다.

---

## 2. 계약

### 2.1 repo가 제공하는 것

```
build.env                  툴체인 버전 단일 선언
scripts/build/android.sh   서명된 AAB 산출
scripts/build/ait.sh       .ait 번들 산출
scripts/build/web.sh       웹 배포물 산출
ios/ci_scripts/            Apple 전용 — Xcode Cloud 규약
```

- **입력은 환경변수**로 받는다. 인자 파싱을 만들지 않는다.
- **출력은 고정 경로**에 둔다. 호출부가 경로를 알아맞히지 않는다.
- **시크릿은 환경변수로 주입받는다.** 스크립트가 시크릿 저장소를 직접 조회하지 않는다. 호출부(Actions / Cloud Build)가 각자의 방식으로 넣는다.
- 스크립트는 **툴체인이 이미 있다고 가정한다.** 없으면 설치하지 말고 실패한다. 설치는 이미지의 책임이다.

`build.env` 예시.

```sh
GODOT_VERSION=4.7.2
GODOT_STATUS=stable
JDK_VERSION=17
```

### 2.2 빌더 이미지

Artifact Registry에 둔다. Godot은 버전이 곧 태그다.

```
godot-android-builder:4.7.2   JDK 17 + Android SDK + Godot 4.7.2 + export templates
rn-android-builder:node24     JDK 17 + Android SDK + Node 24
```

이미지는 Cloud Build로 굽는다(amd64). `build.env`의 `GODOT_VERSION`이 그대로 이미지 태그가 되므로, 엔진을 올릴 때 이미지 태그를 하나 더 굽고 `build.env`만 바꾸면 된다.

### 2.3 호출부가 하는 일

| 실행 위치 | 하는 일 |
|---|---|
| 로컬 | 빌더 이미지를 `docker run`으로 띄우고 스크립트 실행 |
| GitHub Actions | 인증(WIF) → 시크릿 주입 → 컨테이너에서 스크립트 실행 → 아티팩트 업로드 |
| Cloud Build | 같은 이미지를 step으로 두고 같은 스크립트 실행 |

셋이 같은 스크립트를 같은 이미지에서 부르므로, CI 실패를 로컬에서 그대로 재현할 수 있다.

### 2.4 특수 요구를 처리하는 방법

lizard-tycoon처럼 결제 플러그인·custom build template이 필요하면 **그 repo의 `scripts/build/android.sh` 안에서** 처리한다. 재사용 워크플로우를 복사하지 않는다. 워크플로우는 스크립트를 부를 뿐이라 무엇이 들어 있든 상관하지 않는다.

---

## 3. 엔진 버전 정책

- org 전체 Godot은 **4.7.2-stable**로 수렴한다(2026-08-20 확정).
- 버전 상향은 org 단위로 한 번에 한다. repo별로 앞서가거나 뒤처지지 않는다.
- 상향 시 각 repo의 `godot-checks.yml`(compile + smoke)이 통과해야 병합한다. 이 게이트가 없는 repo는 상향 전에 추가한다.
- `build.env`가 유일한 선언이다. 재사용 워크플로우의 `godot_version` 기본값은 계약 이행 후 제거한다.

---

## 4. 마켓별 적용

### Android (Google Play)

x64 Linux가 필요하다(`aapt2`). ARC는 arm64라 쓸 수 없다. 실행 위치는 GitHub-hosted 또는 Cloud Build다. 빌드 자체는 `scripts/build/android.sh`가 소유한다.

### AIT (AppsInToss)

arm64에서 돌아가므로 ARC를 쓴다. `scripts/build/ait.sh`가 소유한다.

### Apple (App Store)

Xcode Cloud가 유일한 경로다. GitHub Actions macOS 러너를 쓰지 않는다. 빌드는 `ios/ci_scripts/ci_post_clone.sh`와 `ci_pre_xcodebuild.sh`가 소유하고, 백오피스가 ASC API로 트리거한다. 자세한 내용은 [org CI/CD 릴리즈 시스템](org-cicd-release-system.md)을 따른다.

Apple만 빌더 이미지를 쓰지 않는다. Xcode Cloud가 실행 환경을 제공하고 컨테이너를 허용하지 않기 때문이다.

---

## 5. 이행 순서

1. 빌더 이미지 구축 — `godot-android-builder:4.7.2`, `rn-android-builder:node24`
2. 시범 repo 1곳(foam-party) — Godot 상향 + `build.env` + `scripts/build/android.sh` + Cloud Build 경로
3. 재사용 워크플로우를 "스크립트 호출"로 축소
4. 나머지 Godot repo 엔진 상향
5. 인라인 caller 4곳을 계약으로 흡수
6. `godot_version` 입력과 `global-versions.yaml`의 중복 선언 제거

각 단계는 이전 단계가 실동작으로 검증된 뒤에 진행한다.
