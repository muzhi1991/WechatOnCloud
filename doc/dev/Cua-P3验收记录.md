# P3：人工与 Agent 控制权交接验收

日期：2026-10-28。范围：llm-server 新建 P3 面板与 Chromium 测试实例，不登录微信、不发送消息、不读取聊天数据库。

## 部署产物

- 面板：`http://192.168.31.101:36083`，`woc-cua-panel-p3`。
- 实例：`P3控制验收`，ID `53c41906da`，容器 `woc-wx-53c41906da`。
- Master 登记：`woc-p3-53c41906da`，受管网关 `http://192.168.31.101:13340`。
- 面板镜像 ID：`sha256:3b0c9a0d6bdf8f3149809d1eb44b3101c8034222528674cddf9d26ff36c07182`。
- 实例镜像 ID：`sha256:a511bc380f43bee25fe7ccfa7e5a49d36a5a4e917b4981995f48c835d21008c9`。
- 实例基于 P1 的 WOC 1.5.2 + spacesd 0.6.0；Mac Cua CLI 0.7.0。
- P3 专属数据卷、网络、端口和凭证；Mac 协调器 `local.woc-cua-p3.sync`。

## 实现

控制权由面板维护，状态为 idle / human / agent / handover / faulted。每次交接生成新 epoch，30 秒 TTL。浏览器使用“账号 + 标签页 nonce”作为身份；Agent 使用独立服务身份申请短期 token。

Cua 原始端口只存在于实例内部。Master 自动登记只读 token；写入必须通过受管 Agent CLI。网关按 RPC 白名单分类，并等待 gRPC 成功 trailers 才认为写入结束。请求断开不提前解除在途计数；结果不确定时锁定输入。管理员恢复会停止旧 driver、等待网页输入辅助进程、释放输入状态。

KasmVNC 使用服务端只读与可写账户；每次交接撤销写权限、关闭旧连接、重置按键和锁定键。网页 type/key/paste 接口检查相同租约；受管辅助进程有文件锁和 15 秒超时，取消延迟剪贴板归还。普通 WOC 实例保留原行为。

## 自动测试

- `panel/server`: `npm run test:control`，13 项：标签页互斥、旧 epoch、Agent 不抢占、在途排空、TTL、异常锁定、恢复和 generation、权限更新失败、迟到的权限授予与恢复竞态、网页输入等待、RPC 白名单、gRPC trailers、客户端断开和 HTTP/2 探测重置。
- `panel/server`: `npm run test:cua`，4 项 P2 注册/凭证/端口回归。
- `node --test integrations/cua-master-sync/*.test.mjs`，6 项协调与传输回归。
- 前后端 `tsc --noEmit`、前端 `npm run build` 通过。

## 实机证据

通过两个真实 Chromium 页面（同一管理员 Cookie，不同标签页身份）和官方 Cua CLI 在本地 HTML 输入框测试。测试页通过窗口标题报告输入结果，读取使用只读 Cua 凭证，避免只看 API 成功返回。

| 场景 | 验证方式 |
| --- | --- |
| 同一桌面 | WOC 页面显示测试页；Cua 窗口列表读取对应标题，Cua 键入可见 |
| 人工互斥 | 标签页 1 取得控制，标签页 2 仍可观看；Agent acquire 被拒绝 |
| 服务端 VNC 只读 | 从只读标签页直接向已连接 WebSocket 发送原始 RFB 按键，输入框不变；持有者同样发送可以输入 |
| 人工接管 | 标签页 2 接管后，标签页 1 的旧 HTTP epoch 返回 409，重新连接的 VNC 仍不能输入 |
| Agent 接管 | 人工交回后 Agent 才能申请；官方 Keyboard RPC 正常输入；网页只读端不能混入字符 |
| 修饰键与 Caps Lock | Agent 按住 Shift、切换 Caps Lock 后由人工接管；人工输入仍为预期小写 |
| 旧 Agent 请求 | 人工接管后旧 token 写入被拒绝，窗口标题无变化 |
| TTL | 无续租等待 32 秒，状态恢复空闲；旧 token 不可写 |
| 控制器重启 | 只重启 P3 面板；旧 token 失效、epoch 和 driver PID 变化，Chromium 与测试文字保留 |
| 网页转发输入 | HTTP type 实际输入；等待超过原先 1 秒归还周期，剪贴板不发生延迟恢复；实机辅助进程持锁期间输入重置等待其退出 |
| 剪贴板只读 | 只读 VNC 连接发送原始 ClientCutText，Agent 设置的剪贴板内容保持不变 |
| 管理员恢复 | 用无效 Keyboard 请求触发保守锁定，网页显示恢复入口；点击后 driver PID 改变，控制状态回到 idle |

确定性的在途阻塞、客户端断线、上游中断和迟到权限更新在独立 HTTP 测试服务器／状态机测试中覆盖；不把这些模拟测试表述为真实微信发送故障验收。

本机截图与测试脚本在 gitignored `artifacts/p3-*` 中，包括 `p3-human-control.png`、`p3-final-desktop.png`、`p3-e2e.cjs`、`p3-e2e-final.log`、`p3-recovery.cjs`。构建过程中修复了 KasmVNC 1.3.3 请求头大小写兼容、HTTP/2 探测连接 reset、异步 WebSocket 鉴权期间断线，以及 driver 重启后尚未就绪便授予控制的问题。

## 现有环境保护与边界

`cua-worker-01`、`woc-cua-canary-01`、P2 面板及其两个实例的容器 ID 与 StartedAt 和阶段前快照一致。没有修改已有微信登录状态。P3 实例镜像升级只作用于本轮新建实例。

本阶段不是正式发布，未推送镜像或建立 release。完整部署和回退步骤见 [P3 部署说明](../../deploy/cua-control/README.md)，任务入口见 [Agent CLI](../../integrations/cua-agent/README.md)。

尚未实现：生命周期维护排空／任务持久化恢复（P4）、实际微信会话验收（P5）、聊天数据库查询、原生 MCP 适配、音频和连续媒体流。管理类操作如重启、升级、文件恢复、主题修改前仍应先交回控制。控制租约是可信参与者的协作机制，不能阻止已获 OS 权限的程序绕开网关持续操作 X11。

上游 KasmVNC 在主动重启造成的断线空档仍可能产生 `lastActiveAt` 前端报错；重新加载后桌面连接恢复，未观察到面板进程因此崩溃。现有依赖审计项沿用 P2 记录，本轮未进行无关大版本升级。
