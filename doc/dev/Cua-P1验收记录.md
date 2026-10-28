# Cua P1 验收记录

日期：2026-10-28。范围：新建独立单实例；不是完整多实例平台交付，也不是正式 release。

## 部署事实

- 主机：llm-server，192.168.31.101，amd64，Docker 25.0.4。
- 部署目录：`/root/woc-cua-canary`；容器：`woc-cua-canary-01`。
- 镜像 ID：`sha256:a2bc099e7d89f01eb26e9b95748f49612bb94533a923cde09685621a62233d8d`。
- WOC release 1.5.2 + main 的图片剪贴板修复 + 本地 Cua 集成；基础镜像 revision label 与 release commit 一致。digest 和下载校验值见 [部署说明](../../deploy/cua/README.md)。GHCR 直连较慢，改经南京镜像站拉取同一 digest，没有修改宿主 Docker 配置。
- Cua 0.6.0；Chromium 154.0.8037.57；KasmVNC 1.3.3；新安装微信 4.1.13.26，停在扫码登录页，未登录、未发送消息。
- 本地 Mac 已登记 `woc-cua-canary-01`。网页 `http://192.168.31.101:36081`，Cua 入口 `http://192.168.31.101:13311`。
- `36081` 是实例 KasmVNC 页面；P1 没有部署 WOC 多实例管理面板。

## 已通过的检查

| 检查 | 实际结果 |
|---|---|
| 独立部署 | 新名称、独立 Compose 网络、独立数据卷和随机凭证；2 CPU / 4 GiB 内存；无宿主 Docker socket |
| 基础健康 | `scripts/cua/smoke.sh` 通过；Cua 以 abc 运行；依赖无缺失；一个 Xvnc；凭证权限为 0400 abc |
| 同一桌面 | KasmVNC 截图与 Cua 截图显示同一浏览器、微信窗口；网页键入 `KasmVNC keyboard OK` 后 Cua 可见，随后 Cua 可继续输入 |
| 中文和剪贴板 | 测试页面显示 Cua 输入的中文；clipboard set/get 返回一致。最终可见回显及 AT-SPI statusbar 都为 `KasmVNC + Cua：中文输入与同桌面验收通过。`，27 字符 |
| 多应用 | 同时有微信、Chromium、xterm；Cua 能列窗口、激活浏览器、在终端输入并执行 printf |
| 最小化 | 浏览器最小化后跨过原 2 秒看守周期仍为 minimized，没有被强制恢复 |
| 分辨率 | 原生桌面 1024×768 → 1280×800；Cua 能继续截图。CLI 将大截图缩至 1200×750，这是输出缩放，原生尺寸以 xrandr/capabilities 为准 |
| 辅助功能 | `cua do a11y tree --json` + `scripts/cua/assert-a11y.py` 通过；可找到 fixture 窗口与中文输入框。最终树 67 节点，含 Chromium 自身提示控件 |
| 重建 | 测试卷中的 `persistence-check.txt`、已安装微信、Cua 身份/凭证在重建后保留；不用重新登记即可恢复连接 |
| 自动初始化 | 重建前将 toolkit-accessibility 设为 false；最终镜像启动后自动恢复 true，并通过辅助功能回归 |
| 服务故障隔离 | 仅终止新容器内的 spacesd，s6 自动恢复；Xvnc PID 保持 244，容器 RestartCount=0 |
| Cua 关闭兼容 | 临时 `woc-cua-disabled-check` 中 `WOC_CUA_ENABLED=0`：Xvnc 和 HTTP 桌面正常，无 spacesd 进程；验证后已清理该临时容器及匿名卷 |
| 上游实例探针 | 最终镜像 Xft/DPI=98304；裸 Chromium 同一临时 profile 连跑两次，各存活 7 秒；微信先到等待安装，再到扫码页 |
| 源码检查 | 修改的 shell 文件 `bash -n` 及 `git diff --check` 通过；未改前后端 TS，未运行无关前端构建 |

截图与诊断输出保存在本地 `artifacts/`，已被 Git 排除；包含扫码页的截图不公开提交。构建只允许所需脚本和校验过的二进制进入 Docker build context。

## 发现与修正

初始图像和键鼠可用，但 `cua do a11y tree` 报 `/config/.XDG/bus` 不存在。WOC 的 startwm 直接运行 Openbox，没有向 Cua 传递会话总线；基础镜像只有 libatspi、没有 `org.a11y.Bus` 服务。新增 `dbus-run-session` 包装原始 startwm，安装固定版本 at-spi2-core，并在应用启动前启用 toolkit-accessibility 与 AT-SPI。回归从失败转为能读到 fixture 输入框；新镜像重建后同样通过。

KasmVNC 输入混合大小写后，实测 Caps Lock 为 on，使下一次 Cua 输入中的 `Cua` 变成 `cUA`。已在当前测试桌面明确复位并验证精确回显；尚未实现自动交接校正，纳入 P3。不能将这次串行测试当作人机并发无冲突保证。

## 已知边界与后续工作

- 微信登录窗口的辅助功能树不可用，需截图/键鼠路线；没有验证登录后的聊天、联系人、发送或消息监听。
- Chromium 某个 text_field 节点的 value 为空，页面 statusbar 的可见回显可读取；读取 UI 要做截图或独立回显校验，不能盲信空 value。
- Cua capabilities 宣告 desktop/window stream 与软件 H.264 可用，但本阶段没有验收 Cua 连续视频/音频；QUIC 关闭。共享 Cua Volume 因无 `/dev/fuse` 不可用，本阶段用独立 `/config/workspace`，未新增特权去开启 FUSE。
- WOC 默认把 `/etc/os-release` 伪装为 deepin 23，因此 Cua UI 会报告 deepin；基础实际仍为 Debian bookworm。保留上游默认行为。
- 人机租约、修饰键交接、自动注册、面板管理、多实例隔离、watchdog、会话自身重启后的协调、长期审计/配额和升级回滚属于 P2～P4。
- 重建会关闭附加应用。Chromium 下次可能提示恢复页面；持久文件已验证保留，不承诺恢复未保存的窗口内容。
- 首版仍需完整平台验收和过夜试运行；没有打 release、没有发布镜像。

## 原有机器保护

前后只读检查 `cua-worker-01` 均为：

```text
ID: 959f491c55967b70af736fa1bacbf6b94ab166b4a6f8d69dd521567791c2502c
StartedAt: 2026-10-23T08:54:23.368071289Z
Status: running
```

本轮没有对原容器执行 exec、停止、重建或改配置，没有复制它的微信数据或凭证。临时检查仅操作 `woc-cua-*` 专用容器。测试主容器保留，供后续阶段使用。
