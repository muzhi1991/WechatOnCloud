#!/bin/bash
set -euo pipefail
# Intentionally fixed to this dedicated test container. Never accepts a production name.
c=woc-cua-canary-01
[[ $(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project" }}') == woc-cua-canary ]]
docker exec "$c" curl -fsS http://127.0.0.1:3211/health
docker exec "$c" bash -euc '
    test "$(stat -c %a /run/woc-cua/token)" = 400
    test "$(stat -c %U /run/woc-cua/token)" = abc
    test -s /run/woc-cua/session.env
    ! ldd /usr/local/bin/cua-spacesd | grep "not found"
    pgrep -u abc -x cua-spacesd >/dev/null
    pgrep -x Xvnc >/dev/null
    test "$(pgrep -xc Xvnc)" = 1
    grep -q DLP_ClipTypes /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run
'
docker exec -u abc "$c" bash -euc '
    source /run/woc-cua/session.env
    test -n "$DBUS_SESSION_BUS_ADDRESS"
    dbus-send --session --type=method_call --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames >/dev/null
    xdpyinfo >/dev/null
    test "$HOME" = /config
    test -w /config/workspace
    /usr/local/bin/cua-spacesd --version
    xrandr --current | head -6
'
docker inspect "$c" --format 'image={{.Image}} status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'
echo 'Infrastructure smoke passed. GUI and persistence checks are separate requirements.'
