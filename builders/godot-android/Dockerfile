# Godot Android 빌드 툴체인.
#
# 이 이미지가 툴체인을 소유한다. repo 의 scripts/build-android.sh 는 도구가 이미
# 있다고 가정하고, 없으면 설치하지 않고 실패한다. 그래야 로컬·GitHub Actions·
# Cloud Build 가 같은 도구로 같은 빌드를 낸다.
#
# 계약: seorilabs/.github docs/ci-cd/build-toolchain-contract.md
#
# Godot 버전은 빌드 인자이자 이미지 태그다. 엔진을 올릴 때 태그를 하나 더 굽고
# 각 repo 의 build.env 만 바꾼다.
FROM eclipse-temurin:17-jdk-noble

ARG GODOT_VERSION=4.7.2
ARG GODOT_STATUS=stable
ARG ANDROID_CMDLINE_TOOLS=13114758
ARG ANDROID_BUILD_TOOLS=35.0.0
ARG ANDROID_PLATFORM=35
ARG NODE_VERSION=24.16.0

# Godot 은 export template 을 XDG_DATA_HOME 아래에서 찾는다(기본 ~/.local/share).
# HOME 은 실행 환경마다 다르다 — Cloud Build 는 /builder/home, 로컬 docker run 은
# 마운트에 따라 또 다르다. 고정 경로로 못박아 어디서 돌든 같은 자리를 보게 한다.
ENV XDG_DATA_HOME=/opt/godot-data \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GODOT_VERSION=${GODOT_VERSION} \
    GODOT_STATUS=${GODOT_STATUS} \
    DEBIAN_FRONTEND=noninteractive

# Godot 헤드리스 export 가 요구하는 런타임과 압축 도구만 넣는다.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip git python3 xz-utils \
      libfontconfig1 libxi6 libxrandr2 libxinerama1 libxcursor1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Node — repo 빌드 스크립트가 쓴다(lizard-tycoon 의 Firebase Analytics 주입 등).
# Ubuntu 24.04 apt 의 nodejs 는 18.x 라 repo 들의 engines 요구(>=24)를 못 맞춘다.
# nodejs.org 공식 빌드를 고정 버전으로 받는다.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) echo "지원하지 않는 아키텍처: $arch" >&2; exit 1 ;; esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${narch}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm /tmp/node.tar.xz

# Android SDK — cmdline-tools 로 platform/build-tools/platform-tools 를 받는다.
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
      "build-tools;${ANDROID_BUILD_TOOLS}" >/dev/null

# build-tools 도 PATH 에 넣는다. 스크립트가 aapt2 를 직접 부를 수 있어야 한다.
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:${PATH}"

# Godot 에디터(헤드리스 export 용)와 export template.
# template 경로는 Godot 이 정한 규약이라 바꾸면 export 가 template 을 못 찾는다.
RUN set -eux; \
    curl -fsSL -o /tmp/godot.zip \
      "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-${GODOT_STATUS}/Godot_v${GODOT_VERSION}-${GODOT_STATUS}_linux.x86_64.zip"; \
    unzip -q /tmp/godot.zip -d /tmp/godot; \
    mv "/tmp/godot/Godot_v${GODOT_VERSION}-${GODOT_STATUS}_linux.x86_64" /usr/local/bin/godot; \
    chmod +x /usr/local/bin/godot; \
    rm -rf /tmp/godot.zip /tmp/godot; \
    curl -fsSL -o /tmp/templates.tpz \
      "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-${GODOT_STATUS}/Godot_v${GODOT_VERSION}-${GODOT_STATUS}_export_templates.tpz"; \
    unzip -q /tmp/templates.tpz -d /tmp/templates; \
    mkdir -p "${XDG_DATA_HOME}/godot/export_templates/${GODOT_VERSION}.${GODOT_STATUS}"; \
    mv /tmp/templates/templates/* "${XDG_DATA_HOME}/godot/export_templates/${GODOT_VERSION}.${GODOT_STATUS}/"; \
    rm -rf /tmp/templates.tpz /tmp/templates

# 이미지가 실제로 쓸 수 있는 상태인지 빌드 시점에 끊는다.
RUN set -eux; \
    godot --headless --version; \
    java -version; \
    node --version; \
    test -f "${XDG_DATA_HOME}/godot/export_templates/${GODOT_VERSION}.${GODOT_STATUS}/android_release.apk"; \
    aapt2 version; \
    sdkmanager --version

# 비root 사용자로 실행되는 경우에도 툴체인을 읽을 수 있어야 한다.
RUN chmod -R a+rX "${XDG_DATA_HOME}" "${ANDROID_HOME}"

WORKDIR /workspace
