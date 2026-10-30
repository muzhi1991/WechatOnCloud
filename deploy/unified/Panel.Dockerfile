# Additive update of the unified panel; build panel/web/dist first.
ARG WOC_PANEL_BASE
FROM ${WOC_PANEL_BASE}
COPY panel/server/src/ /app/src/
COPY panel/web/dist/ /app/web-dist/
ARG WOC_VERSION=dev-control-consent
ENV WOC_VERSION=${WOC_VERSION}
