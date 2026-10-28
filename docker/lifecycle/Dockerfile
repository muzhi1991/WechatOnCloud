ARG WOC_CUA_BASE=local/woc-cua:1.5.2-cua0.6.0-p3
FROM ${WOC_CUA_BASE}
LABEL io.woc.cua.lifecycle="1" io.woc.cua.stage="P4-lifecycle"
# The existing app keeps running; only its relaunch loop pauses while an Agent
# or maintenance owns the desktop. The boot hook copies this into /config.
RUN python3 - <<'PY'
p='/defaults/autostart'
s=open(p).read()
needle='while true; do\n'
assert needle in s
s=s.replace(needle, needle+'    if [ -e /run/woc-control/pause-app ]; then sleep 1; continue; fi\n')
open(p,'w').write(s)
PY
