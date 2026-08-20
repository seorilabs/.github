# React Native Android 빌드 툴체인.
#
# 이 이미지가 툴체인을 소유한다. repo 의 scripts/build-android.sh 는 도구가 이미
# 있다고 가정하고, 없으면 설치하지 않고 실패한다.
#
# 계약: seorilabs/.github docs/ci-cd/build-toolchain-contract.md
ARG JDK_VERSION=17
FROM eclipse-temurin:${JDK_VERSION}-jdk-noble

ARG JDK_VERSION

ARG NODE_VERSION=24.16.0
ARG PNPM_VERSION=11.3.0
ARG ANDROID_CMDLINE_TOOLS=13114758
ARG ANDROID_BUILD_TOOLS=35.0.0
ARG ANDROID_PLATFORM=35
ARG ANDROID_NDK=27.1.12297006

# corepack 은 준비한 패키지매니저를 COREPACK_HOME(기본 ~/.cache/node/corepack)에 캐시한다.
# HOME 은 실행 환경마다 다르다 — 빌드는 /root, Cloud Build 는 /builder/home. 고정하지 않으면
# 이미지에 고정한 pnpm 버전이 런타임에 사라지고 corepack 이 최신을 새로 내려받는다.
ENV COREPACK_HOME=/opt/corepack \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip git python3 xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node — nodejs.org 공식 빌드를 고정 버전으로. corepack 은 번들돼 있다.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) echo "지원하지 않는 아키텍처: $arch" >&2; exit 1 ;; esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${narch}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    chmod -R a+rX "${COREPACK_HOME}"

# Android SDK. RN 은 네이티브 모듈 빌드에 NDK 를 쓰므로 함께 넣는다.
RUN set -eux; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    curl -fsSL -o /tmp/tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip"; \
    unzip -q /tmp/tools.zip -d "${ANDROID_HOME}/cmdline-tools"; \
    mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest"; \
    rm /tmp/tools.zip; \
    yes | "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null; \
    "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" \
      "platforms;android-${ANDROID_PLATFORM}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
      "ndk;${ANDROID_NDK}" >/dev/null

ENV ANDROID_NDK_HOME="${ANDROID_HOME}/ndk/${ANDROID_NDK}" \
    PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:${PATH}"

# 비root 로 실행돼도 툴체인을 읽을 수 있어야 한다.
RUN chmod -R a+rX "${ANDROID_HOME}"

# 이미지가 실제로 쓸 수 있는 상태인지 빌드 시점에 끊는다. 존재 확인이 아니라 실행한다.
RUN set -eux; \
    node --version; \
    test "$(pnpm --version)" = "${PNPM_VERSION}"; \
    java -version; \
    aapt2 version; \
    sdkmanager --version; \
    test -d "${ANDROID_NDK_HOME}"

WORKDIR /workspace
