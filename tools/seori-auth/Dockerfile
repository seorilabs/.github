# syntax=docker/dockerfile:1.11
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS native-build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY tools/seori-auth/package.json tools/seori-auth/package-lock.json ./
COPY tools/seori-auth/native ./native
COPY tools/seori-auth/scripts/build-native.mjs ./scripts/build-native.mjs
RUN npm ci --ignore-scripts \
    && node scripts/build-native.mjs \
    && ./.build/seori-auth-native self-test

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Seori Auth Broker" \
      org.opencontainers.image.source="https://github.com/seorilabs/.github" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

ENV LANG=C.UTF-8 \
    NODE_ENV=production
WORKDIR /opt/seori-auth
COPY --from=native-build --chown=root:root /build/.build/seori-auth-native /opt/seori-auth/bin/seori-auth-native
COPY --from=native-build --chown=root:root /build/node_modules /opt/seori-auth/node_modules
COPY --chown=root:root tools/seori-auth/package.json tools/seori-auth/package-lock.json ./
COPY --chown=root:root tools/seori-auth/src ./src
COPY --chown=root:root tools/seori-auth/runtime ./runtime
RUN mkdir -p /etc/seori-auth/tls /etc/seori-auth/egress /run/seori-auth /var/lib/seori-auth \
    && chown root:root /etc/seori-auth /etc/seori-auth/tls /etc/seori-auth/egress \
    && chmod 0555 /etc/seori-auth /etc/seori-auth/tls /etc/seori-auth/egress \
    && chmod 0555 /opt/seori-auth/bin/seori-auth-native /opt/seori-auth/runtime/entrypoint.mjs \
    && find /opt/seori-auth -type d -exec chmod 0555 {} + \
    && find /opt/seori-auth/src /opt/seori-auth/runtime -type f -exec chmod 0444 {} + \
    && chown 65532:65532 /run/seori-auth /var/lib/seori-auth \
    && chmod 0700 /run/seori-auth /var/lib/seori-auth

USER 65532:65532
ENTRYPOINT ["/opt/seori-auth/bin/seori-auth-native", "launch", "--", "/usr/local/bin/node", "/opt/seori-auth/runtime/entrypoint.mjs"]
CMD ["canary", "--native-helper=/opt/seori-auth/bin/seori-auth-native"]
