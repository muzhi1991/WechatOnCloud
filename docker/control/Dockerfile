# P3 adds server-side Kasm permissions to the validated P1 desktop.
ARG WOC_CUA_BASE=local/woc-cua:1.5.2-cua0.6.0-p1
FROM ${WOC_CUA_BASE}
LABEL io.woc.cua.control="1" io.woc.cua.stage="P3-control"
COPY docker/control/init /custom-cont-init.d/04-woc-control
COPY docker/control/reset-input.py /woc/control/reset-input.py
COPY docker/control/fence /woc/control/fence
COPY docker/control/http-input /woc/control/http-input
RUN chmod 755 /custom-cont-init.d/04-woc-control /woc/control/fence /woc/control/http-input \
 && sed -i 's/-disableBasicAuth \\/-KasmPasswordFile \/run\/woc-control\/kasm.passwd \\/' /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run \
 && grep -q 'KasmPasswordFile /run/woc-control/kasm.passwd' /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run
