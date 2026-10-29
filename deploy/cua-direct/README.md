# P5 原生 Cua Spaces 直连

2026-10-29 已部署并通过原生 App 画面、鼠标和键盘验收。在 Mac 的 Cua Spaces 中选择 **P5微信直连**，点击 **Open in window** 即可操作现有微信。这里的 Full desktop 指现有 X 显示器的完整画面，不代表已安装完整桌面环境。

这是用户选择的最简独立入口，直接连接 P5 内已有的 `cua-spacesd`，不经过 WOC 控制租约。浏览器与直连窗口同时输入时不会互斥。原 WOC 网页、受管 Agent 入口及其协调机制保留。

## 连接路径

```text
Cua Spaces / direct:127.0.0.1:14361
  → Mac SSH tunnel 127.0.0.1:14361
  → llm-server 192.168.31.101:13361 (systemd socket-proxyd)
  → woc-wx-77bafd5161 的 Docker IP:3211 (已有 cua-spacesd)
```

新增原始 TCP 转发同时承载 RPC 和原生视频 WebSocket。旧受管入口 `13341` 只支持所需的 unary gRPC-Web 调用，不能作为原生桌面视频入口。

本机独立 CLI 连接 LAN 成功，但常驻 Cua daemon 连接同一地址返回 `No route to host`；其根因尚未确定。SSH loopback 路径已在正常 daemon 和原生 App 验证可用，没有修改 Mac 隐私设置或重启原 Cua daemon。

服务仍验证 P5 的 bearer token。宿主转发绑定指定 LAN 地址而非所有接口；Mac 端仅监听 loopback。宿主入口不是公网部署方案。

## 已部署文件及启动方式

宿主机 `root@192.168.31.101`：

- `proxy` → `/usr/local/libexec/woc-p5-cua-direct`，权限 0755。
- 两个 `woc-p5-cua-direct.*` unit → `/etc/systemd/system/`。
- `systemctl daemon-reload` 后执行 `systemctl enable --now woc-p5-cua-direct.socket`。
- 使用系统已有的 `/usr/lib/systemd/systemd-socket-proxyd`，无需新增镜像或重建容器。

Mac：

- `launchd.plist.example` 中的 `__STATE_DIR__` 替换为本机绝对路径 `~/.local/share/woc-cua-p5-direct` 展开后的值。
- 保存为 `~/Library/LaunchAgents/local.woc-p5-cua-direct.plist`，通过 `launchctl bootstrap gui/$(id -u) 文件路径` 加载。
- SSH 使用现有密钥授权，后台保持连接，登录 Mac 后自动启动，掉线后重连。日志位于状态目录的 `tunnel.log`。
- 私有 token 保存在状态目录的 `token`（0600；目录 0700），不进入仓库。使用 `CUA_ENV_TOKEN` 环境变量调用 `cua spaces add --json http://127.0.0.1:14361 --name P5微信直连` 注册，避免将 token 放在命令参数中。

这些配置只针对 P5，未实现所有新实例的自动直连登记。原有受管注册仍由原同步服务维护，新 loopback 注册不在其管理范围内。

## 验证

Node.js 22 或更新版本（需内置 WebSocket），从仓库根目录运行：

```sh
node deploy/cua-direct/verify.mjs http://127.0.0.1:14361 \
  "$HOME/.local/share/woc-cua-p5-direct/token" "$HOME/.local/bin/cua"
```

脚本检查匿名 Screenshot 被拒绝、Health serving、创建 H264 媒体会话、实际收到二进制视频数据，并关闭该测试会话。不会输入或输出凭证、媒体 ticket、截图和消息内容。

本次实测：H264，1176×894，收到 3 条二进制消息共 87611 字节。原生 App 的独立窗口显示实时微信画面；在微信搜索框点击并输入 `CUAinputtest`，画面确认文字生效，随后点击清除并退出搜索，确认原界面恢复。没有发送消息。另已验证直接 RPC 输入不需 WOC 租约。

前后对比 8 个受保护容器，ID 与 StartedAt 均未变化；没有重启容器或改变微信登录态。参见 [P5 验收记录](../../doc/dev/Cua-P5验收记录.md)。

## 运维边界与回滚

代理每次启动按容器名和指定 Docker 网络解析 IP，空闲 60 秒退出并等待下一次 socket 激活。若 P5 重建且旧代理仍保持连接，执行 `systemctl restart woc-p5-cua-direct.service` 重新解析；只重启这个代理。P5 token 轮换后需要更新私有 token 和直连注册。这里不承诺重建期间无缝恢复。

移除此入口时，仅执行：

```sh
# Mac：移除新增注册，停止新增隧道。
cua spaces rm --json direct:127.0.0.1:14361
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/local.woc-p5-cua-direct.plist"
# 同时移走该 plist，避免下次登录再次加载；可保留备份以恢复。

# llm-server：停止新增 socket 和可能仍在运行的代理。
systemctl disable --now woc-p5-cua-direct.socket
systemctl stop woc-p5-cua-direct.service
```

回滚不需要修改 WOC、停止微信、移除数据卷或删除原有 Cua Spaces 注册。
