# Optional layer for NEW application/desktop instances. Existing images stay intact.
ARG WOC_BASE=local/woc-cua:1.5.2-cua0.6.0-p4
FROM ${WOC_BASE}
COPY services/woc-daemon/server.py services/woc-daemon/ui_service.py services/woc-daemon/wechat_ui.py /opt/woc-read/
COPY deploy/read-daemon/init /custom-cont-init.d/09-woc-read
RUN chmod 755 /custom-cont-init.d/09-woc-read
# Account configuration, per-instance credential and verified wx binary are provisioned
# privately under /config/woc-read; never bake account data or keys into an image.
