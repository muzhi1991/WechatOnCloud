# Build panel/web/dist with npm ci && npm run build first.
# Keep the exact deployed server and old hashed assets for already-open pages.
ARG WOC_PANEL_BASE
FROM ${WOC_PANEL_BASE}
COPY panel/web/dist/ /app/web-dist/
ARG WOC_VERSION=dev-control-refresh
ENV WOC_VERSION=${WOC_VERSION}
