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
scripts/build-android.sh   서명된 AAB 산출
scripts/build-ait.sh       .ait 번들 산출
scripts/build-web.sh       웹 배포물 산출
ios/ci_scripts/            Apple 전용 — Xcode Cloud 규약
```

**`scripts/build/` 디렉터리를 쓰지 않는다.** 대부분의 repo `.gitignore`에 `build/`가 있고 그 패턴은 `scripts/build/`까지 잡는다. 스크립트가 커밋되지 않은 채 CI만 통과하고 로컬에는 파일이 없는 상태가 된다. foam-party에서 실제로 겪었다.

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
rn-android-builder:node24-jdk21  JDK 21 + Android platform 36 + Node 24 — Capacitor 8
rn-android-builder:node24-pnpm11.14-jdk21-rn085  JDK 21 + Android platform 36 + CMake 3.22.1 + Node 24.16.0 + pnpm 11.14.0 — babycare RN 0.85
```

JDK tag는 앱 Gradle이 요구하는 source level과 맞춘다. Capacitor 8의 생성 Gradle과
`@capacitor/android`는 Java 21 source/target compatibility를 선언하므로 JDK 17 이미지에서
컴파일되지 않는다. 기존 RN 앱의 검증된 `node24` tag는 바꾸지 않고 `node24-jdk21`을
additive tag로 둔다.

이미지는 Cloud Build로 굽는다(amd64). 레시피는 [`builders/`](../../builders/)에 있다. `build.env`의 `GODOT_VERSION`이 그대로 이미지 태그가 되므로, 엔진을 올릴 때 이미지 태그를 하나 더 굽고 `build.env`만 바꾸면 된다.

**이 저장소에는 공개 툴체인만 넣는다.** 앱 소스, 빌드 산출물(AAB/.ait), 앱 컨테이너 이미지, 시크릿은 넣지 않는다. 앱 이미지는 각자의 비공개 레지스트리에 둔다(백오피스 `registry.vzyx.xyz`, platform `seorilabs-platform`). 산출물은 GCS나 GitHub Artifacts로 간다.

읽기 권한은 각 repo가 이미 쓰는 WIF 신원에 부여한다. 저장소를 공개로 열지 않는다 — 조직 정책 `constraints/iam.allowedPolicyMemberDomains`가 `allUsers` 부여를 막으며, 그 정책이 나중에 비밀이 섞인 이미지가 실수로 공개되는 것을 막는 통제다.

### 2.3 호출부가 하는 일

| 실행 위치 | 하는 일 |
|---|---|
| 로컬 | `gcloud auth configure-docker` 후 빌더 이미지를 `docker run`으로 띄우고 스크립트 실행 |
| GitHub Actions | WIF 인증 → Docker 인증 → `docker run`으로 스크립트 실행 → 아티팩트 업로드 |
| Cloud Build | 같은 이미지를 step으로 두고 같은 스크립트 실행 |

GitHub Actions에서 잡 레벨 `container:`를 쓰지 않는다. 스텝이 돌기 전에 이미지를 받으므로 WIF 토큰을 쓸 수 없고, 정적 리더 키를 만들거나 저장소를 공개해야 한다. 인증 스텝 비용(빌드당 15~30초)을 치르고 둘 다 피한다.

셋이 같은 스크립트를 같은 이미지에서 부르므로, CI 실패를 로컬에서 그대로 재현할 수 있다.

### 2.4 특수 요구를 처리하는 방법

lizard-tycoon처럼 결제 플러그인·custom build template이 필요하면 **그 repo의 `scripts/build-android.sh` 안에서** 처리한다. 재사용 워크플로우를 복사하지 않는다. 워크플로우는 스크립트를 부를 뿐이라 무엇이 들어 있든 상관하지 않는다.

---

## 3. 엔진 버전 정책

- org 전체 Godot은 **4.7.2-stable**로 수렴한다(2026-08-20 확정).
- **lizard-tycoon은 4.6.3에 머문다(2026-08-21 결정).** 표류가 아니라 결정이다.
  결제·알림·인앱리뷰 plugin 중 둘이 엔진 마이너마다 잠기고, 그 위험을 잡을 게이트가
  이 repo에는 없다(§5의 lizard 항목). 빌더 이미지는 `4.6.3` 태그를 유지한다.
  상향은 plugin 교체·호출부 API 대조·iOS 재검증·실기기 QA와 함께 다시 판단한다.
- 버전 상향은 org 단위로 한 번에 한다. repo별로 앞서가거나 뒤처지지 않는다.
- 상향 시 각 repo의 `godot-checks.yml`(compile + smoke)이 통과해야 병합한다. 이 게이트가 없는 repo는 상향 전에 추가한다.
- `build.env`가 유일한 선언이다. 재사용 워크플로우의 `godot_version` 기본값은 계약 이행 후 제거한다.

---

## 4. 마켓별 적용

### Android (Google Play)

x64 Linux가 필요하다(`aapt2`). ARC는 arm64라 쓸 수 없다. 실행 위치는 GitHub-hosted 또는 Cloud Build다. 빌드 자체는 `scripts/build-android.sh`가 소유한다.

**Cloud Build 로 보낼 때의 권한과 함정은 `seorilabs-cloud-build` 스킬을 따른다.**
WIF 로 다른 프로젝트에 제출하면 권한 6종과 쿼터 프로젝트 지정이 모두 필요하고,
gcloud 의 에러 문구가 실제 원인을 잘못 지목한다. 2026-08-21 전환에서 그 문구를 믿고
버킷 IAM 만 두 번 손대다 시간을 버렸다.

### AIT (AppsInToss)

arm64에서 돌아가므로 ARC를 쓴다. `scripts/build-ait.sh`가 소유한다.

### Apple (App Store)

Xcode Cloud가 유일한 경로다. GitHub Actions macOS 러너를 쓰지 않는다. 빌드는 `ios/ci_scripts/ci_post_clone.sh`와 `ci_pre_xcodebuild.sh`가 소유하고, 백오피스가 ASC API로 트리거한다. 자세한 내용은 [org CI/CD 릴리즈 시스템](org-cicd-release-system.md)을 따른다.

Apple만 빌더 이미지를 쓰지 않는다. Xcode Cloud가 실행 환경을 제공하고 컨테이너를 허용하지 않기 때문이다.

---

## 5. 이행 순서

1. 빌더 이미지 구축 — `godot-android-builder:4.7.2`, `rn-android-builder:node24`
2. 시범 repo — Godot 상향 + `build.env` + `scripts/build-android.sh` + Cloud Build 경로
3. 재사용 워크플로우를 "스크립트 호출"로 축소
4. 나머지 Godot repo 엔진 상향
5. 인라인 caller 4곳을 계약으로 흡수
6. `godot_version` 입력과 `global-versions.yaml`의 중복 선언 제거

각 단계는 이전 단계가 실동작으로 검증된 뒤에 진행한다.

### 진행 상황 (2026-08-20)

| 단계 | 상태 |
|---|---|
| 빌더 이미지 | `godot-android-builder:4.7.2`, `rn-android-builder:node24` 구축·검증 완료. 레시피는 [`builders/`](../../builders/) |
| 시범 repo | spiritgate-defenders 전환 완료. AAB 산출과 업로드 인증서 지문 대조까지 확인 |
| Godot repo 전환 | jomul, matgo 완료 |
| 인라인 caller 흡수 | lizard-tycoon 조사 완료 — 계약 전환과 엔진 상향을 분리한다(아래) |

foam-party 를 첫 시범으로 잡았다가 spiritgate-defenders 로 바꿨다. foam-party 에서
`scripts/build/` 가 `.gitignore` 의 `build/` 에 걸려 커밋되지 않는 사고를 겪었고, 그 교훈이
§2.1 의 디렉터리 금지 조항이 됐다.

### lizard-tycoon — 전환과 상향을 분리한다

인라인 caller 4곳 중 가장 무거운 repo 를 먼저 조사했다. 결론은 **계약 전환(빌드 위치)과
엔진 상향(산출물)을 같은 변경에 넣지 않는다** 다.

- 이탈 사유 3개 중 2개가 이미 무효다. custom Gradle build template 과 AAB 모드는
  spiritgate-defenders 도 쓰며 계약 안에서 돌아간다. 빌드 시점 GitHub Releases 다운로드도
  실증됐다(AdMob 플러그인).
- 남은 실결손은 **Node 하나**다. lizard 의 export 스크립트가 Firebase Analytics 주입에
  `node` 를 부르는데 `godot-android-builder` 에 Node 가 없다.
- 진짜 위험은 엔진이다. lizard 는 Godot 4.6.3 이고, 결제·알림·인앱리뷰 플러그인 중 두 종은
  upstream 이 엔진 마이너마다 버전을 잠근다. 4.7 대응판은 addon 트리가 재구성돼 있어
  체크섬 교체로 끝나지 않는다. 알림 플러그인은 iOS 바이너리도 함께 배포하므로 상향이
  Xcode Cloud 까지 끌고 간다.
- **`godot-checks.yml` 이 이 위험을 잡지 못한다.** caller 가 `godot_version` 을 넘기지 않아
  org 기본값으로 돌고, `with_export_templates` 가 false 라 Android export 를 하지 않는다.
  상향은 게이트를 초록으로 통과하고 마켓 배포에서 터진다. §3 이 요구하는 "상향 전 게이트"의
  전제가 이 repo 에서는 성립하지 않는다.

따라서 순서는 이렇다.

1. 빌더 이미지에 Node 24 를 넣고 `godot-android-builder:4.6.3` 태그를 굽는다.
2. **엔진을 4.6.3 에 고정한 채** 계약으로 전환한다. 산출물 대조로 검증된다.
3. 엔진 상향은 별도 변경으로, 플러그인 버전 교체·호출부 API 대조·iOS 재검증·실기기 QA 와
   함께 한다. `godot-checks.yml` 이 `build.env` 를 읽도록 배선하는 것도 여기 포함한다.

엔진 상향이 이렇게 무거운 repo 가 있으므로, §3 의 "org 전체가 4.7.2 로 수렴한다"는
**목표이지 일정이 아니다.** 게이트가 상향을 실제로 검증하지 못하는 repo 는 게이트를 먼저
갖춘 뒤 올린다.
