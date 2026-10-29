# Additive server-only update; retains the unified console and existing web assets.
ARG WOC_PANEL_BASE=woc-panel:lock-v3
FROM ${WOC_PANEL_BASE}
COPY panel/server/src/ /app/src/
ARG WOC_VERSION=dev-read-daemon-v1
ENV WOC_VERSION=${WOC_VERSION}
