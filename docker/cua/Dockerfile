# Build context: repository root. P1 is pinned to the verified amd64 release.
ARG WOC_BASE=ghcr.io/gloridust/wechat-on-cloud:1.5.2@sha256:731891df34ad53ea7000415d6e2b3fcb990dc3aadc63a59a15b06e521b165cf8
FROM ${WOC_BASE}
ARG CUA_VERSION=0.6.0
ARG CUA_SHA256=73f4ab392d7832561b454ce137114f22242753f43a9e95166259bbf72e514379
LABEL io.woc.cua.stage="P1-canary" io.woc.cua.version="${CUA_VERSION}"
COPY artifacts/cua-spacesd /usr/local/bin/cua-spacesd
RUN echo "${CUA_SHA256}  /usr/local/bin/cua-spacesd" | sha256sum -c - \
    && chmod 755 /usr/local/bin/cua-spacesd \
    && /usr/local/bin/cua-spacesd --version

# Carry the upstream main clipboard fix missing from release 1.5.2.
RUN f=/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run; \
    grep -q -- '-DLP_ClipTypes' "$f" || sed -i 's|/usr/local/bin/Xvnc \$DISPLAY \\|/usr/local/bin/Xvnc $DISPLAY -DLP_ClipTypes text/html \\|' "$f"; \
    grep -q -- '/usr/local/bin/Xvnc \$DISPLAY -DLP_ClipTypes text/html \\' "$f"
COPY docker/autostart /defaults/autostart
RUN mv /defaults/startwm.sh /defaults/woc-startwm.original
COPY docker/cua/startwm /defaults/startwm.sh
COPY docker/cua/publish-session docker/cua/serve /woc/cua/
COPY docker/cua/init /custom-cont-init.d/03-woc-cua
COPY docker/cua/run docker/cua/finish /etc/s6-overlay/s6-rc.d/svc-woc-cua/
RUN chmod 755 /defaults/autostart /woc/cua/* /custom-cont-init.d/03-woc-cua \
      /etc/s6-overlay/s6-rc.d/svc-woc-cua/run /etc/s6-overlay/s6-rc.d/svc-woc-cua/finish \
    && printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-woc-cua/type \
    && mkdir -p /etc/s6-overlay/s6-rc.d/svc-woc-cua/dependencies.d \
    && touch /etc/s6-overlay/s6-rc.d/svc-woc-cua/dependencies.d/init-services \
      /etc/s6-overlay/s6-rc.d/user/contents.d/svc-woc-cua
# The base has libatspi but omits the session-bus service (no recommends).
RUN printf 'deb https://deb.debian.org/debian bookworm main\n' > /tmp/cua-apt.list \
    && apt-get -o Dir::Etc::sourcelist=/tmp/cua-apt.list -o Dir::Etc::sourceparts=- -o Acquire::Retries=3 update \
    && apt-get -o Dir::Etc::sourcelist=/tmp/cua-apt.list -o Dir::Etc::sourceparts=- \
      install -y --no-install-recommends at-spi2-core=2.46.0-5 \
    && rm /tmp/cua-apt.list && rm -rf /var/lib/apt/lists/*
EXPOSE 3211
