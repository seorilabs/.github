# 빌더 이미지

[빌드 툴체인 계약](../docs/ci-cd/build-toolchain-contract.md)이 "툴체인은 빌더 이미지가
제공한다"고 정한다. 그 이미지를 굽는 레시피가 여기 있다. 레지스트리에 떠 있는 이미지를
git 에서 재현할 수 없으면 "단일 진실"이 아니다.

레지스트리는 `asia-northeast3-docker.pkg.dev/seorilabs-ci/builders` 다. 공개하지 않는다 —
조직 정책 `constraints/iam.allowedPolicyMemberDomains`가 `allUsers` 부여를 막고,
그 정책이 나중에 비밀이 섞인 이미지가 실수로 공개되는 것을 막는 통제다.

## 굽기

Cloud Build 로 굽는다(amd64). Godot 은 **버전이 곧 태그**다.

```sh
export CLOUDSDK_PYTHON="$(pyenv root)/versions/3.12.11/bin/python"
GC=~/.config/seorilabs/scripts/gcloud-cli.sh

# Godot Android — 엔진 버전을 태그와 빌드 인자 양쪽에 같은 값으로 준다
"$GC" builds submit builders/godot-android \
  --project=seorilabs-ci --region=asia-northeast3 \
  --tag=asia-northeast3-docker.pkg.dev/seorilabs-ci/builders/godot-android-builder:4.7.2

# React Native Android
"$GC" builds submit builders/rn-android \
  --project=seorilabs-ci --region=asia-northeast3 \
  --tag=asia-northeast3-docker.pkg.dev/seorilabs-ci/builders/rn-android-builder:node24

# Capacitor 8 Android — 생성 Gradle이 Java 21 source level을 요구한다
"$GC" builds submit builders/rn-android \
  --project=seorilabs-ci --region=asia-northeast3 \
  --config=builders/rn-android/build.cloudbuild.yaml \
  --substitutions=_JDK_VERSION=21,_ANDROID_PLATFORM=36,_IMAGE_TAG=node24-jdk21
```

엔진을 올릴 때는 새 태그를 하나 더 굽고 각 repo 의 `build.env` 만 바꾼다. 기존 태그는
지우지 않는다 — 뒤처진 repo 가 아직 그 태그를 쓴다.

## 검증

굽고 나면 `verify.cloudbuild.yaml` 로 도구가 실제로 실행되는지 확인한다. 존재 확인(`ls`)이
아니라 실행(`godot --version`, `aapt2 version`)으로 끊는다. 파일이 있어도 못 쓰는 경우를
겪었다.

```sh
"$GC" builds submit --no-source --project=seorilabs-ci --region=asia-northeast3 \
  --config=builders/godot-android/verify.cloudbuild.yaml

"$GC" builds submit --no-source --project=seorilabs-ci --region=asia-northeast3 \
  --config=builders/rn-android/verify.cloudbuild.yaml \
  --substitutions=_JDK_VERSION=21,_ANDROID_PLATFORM=36,_IMAGE_TAG=node24-jdk21
```

## 이미지에 넣는 것과 넣지 않는 것

**넣는다**: JDK, Android SDK, Godot 엔진과 export template, Node·pnpm 같은 공개 툴체인.

**넣지 않는다**: 앱 소스, 빌드 산출물(AAB/.ait), 앱 컨테이너 이미지, 시크릿.
앱 이미지는 각자의 비공개 레지스트리에 둔다(백오피스 `registry.vzyx.xyz`,
platform `seorilabs-platform`). 산출물은 GCS 나 GitHub Artifacts 로 간다.

## 환경변수를 고정하는 이유

두 Dockerfile 모두 `HOME` 에 의존하는 경로를 고정 경로로 못박는다. `HOME` 은 실행 환경마다
다르다 — 로컬 `docker run` 은 마운트에 따라, Cloud Build 는 `/builder/home`. 고정하지 않으면
이미지에 넣은 것을 런타임에 못 찾는다.

- `XDG_DATA_HOME=/opt/godot-data` — Godot 이 export template 을 여기서 찾는다
- `COREPACK_HOME=/opt/corepack` — 고정하지 않으면 이미지에 고정한 pnpm 버전이 사라지고
  corepack 이 런타임에 최신을 새로 내려받는다

## 알려진 격차

**`godot-android-builder:4.7.2` 의 Android build-tools 가 Godot 4.7.2 의 요구와 어긋난다.**
이미지는 build-tools 35.0.0 / platform 35 를 담는데 Godot 4.7.2 의 `config.gradle` 은
compileSdk 36 / buildTools 36.1.0 을 선언한다. 빌드 로그에 이렇게 남는다.

```
Could not find version of build tools that matches Target SDK, using 35.0.0
```

빌드는 성공하고 서명도 정상이다(spiritgate-defenders·jomul·matgo 세 곳에서 AAB 산출과
업로드 인증서 지문 대조까지 확인). Gradle 이 35.0.0 으로 물러나 진행하기 때문이다.
다만 targetSdk 와 맞지 않는 build-tools 로 빌드하는 상태이므로 정합을 맞춰야 한다.

고치려면 `ANDROID_BUILD_TOOLS=36.1.0`, `ANDROID_PLATFORM=36` 으로 태그를 다시 굽고
**해당 태그를 쓰는 repo 전부를 다시 검증**해야 한다. 이 README 가 기록하는 레시피는
지금 레지스트리에 떠 있고 위 세 repo 의 검증된 AAB 를 만들어낸 그 이미지다. 레시피를 먼저
바꾸면 git 이 레지스트리를 더 이상 설명하지 못한다.
