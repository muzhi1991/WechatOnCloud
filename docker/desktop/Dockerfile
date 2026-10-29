# Build context: repository root. The existing application image is unchanged.
ARG WOC_DESKTOP_BASE=local/woc-cua:1.5.2-cua0.6.0-p4
FROM ${WOC_DESKTOP_BASE}
LABEL io.woc.desktop="1" io.woc.desktop.version="1" io.woc.cua.stage="D1-desktop"
RUN printf 'deb https://deb.debian.org/debian bookworm main\n' > /tmp/desktop-apt.list \
 && apt-get -o Dir::Etc::sourcelist=/tmp/desktop-apt.list -o Dir::Etc::sourceparts=- -o Acquire::Retries=3 update \
 && apt-get -o Dir::Etc::sourcelist=/tmp/desktop-apt.list -o Dir::Etc::sourceparts=- install -y --no-install-recommends \
      tint2=17.0.1-1 pcmanfm=1.3.2-1 \
 && dpkg-query -W tint2 pcmanfm openbox xterm \
 && rm /tmp/desktop-apt.list && rm -rf /var/lib/apt/lists/*
COPY docker/desktop/session docker/desktop/launch /woc/desktop/
COPY docker/desktop/tint2rc docker/desktop/menu.xml /woc/desktop/
COPY docker/desktop/init /custom-cont-init.d/05-woc-desktop
# Remove application-mode entry points from this derived artifact. Never patch their bodies.
COPY docker/desktop/autostart /defaults/autostart
RUN rm /custom-cont-init.d/00-woc-identity /custom-cont-init.d/01-woc-autostart /custom-cont-init.d/02-woc-app \
 && chmod 755 /defaults/autostart /woc/desktop/session /woc/desktop/launch /custom-cont-init.d/05-woc-desktop
