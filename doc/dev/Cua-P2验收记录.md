# Cua P2 动态创建与自动注册验收

日期：2026-10-28。范围：独立试运行面板与新容器，未迁移既有 Cua worker。P1 派生镜像复用，P2 新增面板集成和指定 Mac 的协调器。

## 部署产物

- 本地仓库：`wechat-on-cloud`，分支 `feat/cua-integration`；本轮不发布镜像、不触发 GitHub Actions、不推送 release。
- llm-server：`/root/woc-cua-panel`；面板 `woc-cua-panel-p2`，访问 `http://192.168.31.101:36082`。
- 面板最终镜像：`local/woc-panel:cua-p2`，ID `sha256:98f5872b5db2bcc76ccfb801c31af8aeeb5ea9115a298c912006abe1d5d7855b`。
- 实例镜像：`sha256:a2bc099e7d89f01eb26e9b95748f49612bb94533a923cde09685621a62233d8d`，Cua spacesd 0.6.0。
- 新实例网络 `woc-cua-p2-instances`，面板数据库卷 `woc-cua-panel-p2-data`。
- deploymentId：`9eb2d37a-6dea-4757-9ba1-0b911b24bcb6`；Master CLI 0.7.0，命名空间 `woc-p2`。
- Mac 配置/ledger：`~/.local/share/woc-cua-p2/`；LaunchAgent `local.woc-cua-p2.sync`，10 秒对账。

| 保留实例 | WOC ID / 容器 | Cua 注册表 ID | 状态 |
| --- | --- | --- | --- |
| P2微信1 | 0bd47b675b / woc-wx-0bd47b675b | direct:192.168.31.101:13320 | 微信 4.1.13.26 已安装，扫码页未登录 |
| P2浏览器2 | 768c59bc63 / woc-wx-768c59bc63 | direct:192.168.31.101:13321 | Chromium 可用；重建后 generation 2 |

临时删除测试实例 `85c93aa352` 使用端口 13322，已删除容器、数据卷、凭证和 Master 登记；仅保留 tombstone 与端口预留。

## 验收结果

| 验证 | 结果与证据 |
| --- | --- |
| 构建 | 前后端 `tsc --noEmit`、Vite 生产构建、目标 Linux Docker 构建通过 |
| 单元/契约测试 | registry 4 项、协调器与系统 HTTP 传输 6 项，全部通过 |
| 实际网页创建 | Playwright 在真实 Chrome 中登录、新建微信和 Chromium、勾选 Cua；两卡片自动显示「已接入 Master」 |
| 自动登记 | 无手动 spaces add，两实例自动出现在当前 Mac 的 `cua spaces ls --json`；直接用注册表 ID 切换并截图成功 |
| 人工桌面 | 网页「进入实例」正常显示 Chromium 桌面；与 Cua 截图是同一 X 会话 |
| 两实例隔离 | 端口和 token 不同；经 Cua exec 分别写入同名 `/config/workspace/p2-identity`，各自读出对应 ID |
| 停止 | 面板停止浏览器实例，状态 offline，Master 保留身份；重启面板后该实例仍为 exited |
| 再启动 | 原端口、token、generation 和工作文件保留，恢复 ready |
| 重建 | Docker 容器 ID 改变，镜像仍是固定派生 ID；token/端口/文件保持，generation 1→2；旧 generation ACK 返回 409 |
| 协调器重启 | SIGTERM 后 launchd 自动重启，健康状态恢复；未重复登记，既有两台 Space 未被删除 |
| 删除 | 第三个临时实例自动登记后，通过面板删除；凭证文件/容器/卷/对应 Master 项清理，另外两个工作文件可继续读取 |
| 服务身份 | 无认证和仅管理员 Cookie 访问 snapshot 均 401；普通实例列表无 token/secretRef/kasmPassword |
| 网络与凭证隔离 | A token 访问 B 的 Cua 被拒绝；从实例访问面板 API 返回 403 |
| 原环境保护 | cua-worker-01 的 ID、StartedAt 与 P1 前置记录相同；P1 canary 的容器也未被本轮重建 |

原 worker 对比值：容器 ID `959f491c55967b70af736fa1bacbf6b94ab166b4a6f8d69dd521567791c2502c`；StartedAt `2026-10-23T08:54:23.368071289Z`。本轮仅通过宿主 Docker inspect 查看该记录，没有进入或修改它。

本地截图（gitignored）：`artifacts/p2-create-dialog.png`、`p2-panel.png`、`p2-web-desktop.png`、`p2-cua-browser.png`、`p2-cua-wechat.png`。Cua 截图轨迹：`~/.cua/trajectories/direct_192.168.31.101_13320/20261028-125355/` 与 `direct_192.168.31.101_13321/20261028-125023/`。生命周期和删除实测脚本在本地 `artifacts/p2-*.mjs`，凭证只在运行时内存读取。

## 本轮发现和处理

1. 当前 Mac 的 launchd 下 Node fetch 连接 LAN 返回 EHOSTUNREACH，而同一进程环境下系统 curl 与官方 Cua CLI 正常。增加可选系统 HTTP 传输，认证内容经 stdin；常驻同步和重启实测成功。增加 POST、拒绝重定向、错误 JSON 脱敏测试。
2. Cua CLI 0.7.0 的 `do switch <显示名称>` 不等于 direct Space 注册项。使用 `do switch direct:host:port` 即可；协调器无需改变当前桌面选择。
3. 上游 watchdog 对 0 的配置处理不正确，本轮修复并测试，试运行保持关闭；同时禁止全局镜像清理。
4. Cua 创建/升级不回退上游镜像，重建继续使用已有 image ID；停止错误不再一律吞掉。
5. 构建审计发现继承的 proxy-addr 2.0.7 命中 [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)。仅将该间接依赖锁文件升级至补丁版 2.0.8，重新构建、检查登录和代理；没有执行全量强制依赖升级。最终服务端生产依赖审计仍有 11 项（1 low、3 moderate、7 high），前端构建报告 17 项；完整依赖审计与升级仍是正式发布前待办，本轮不是安全审计结论。

## 限制和后续门禁

P2 只通过动态创建与自动登记门禁。尚未提供人工/Agent 的服务端互斥；必须串行操作。P1 观察到的 Caps Lock 遗留、微信 AT-SPI 不可见继续作为 P3 输入，不能把「已接入 Master」解释为并发控制已经安全。

停止协调器不撤销已有 Cua token；端口暂不回收。当前为单面板写入者、单 Master，未验证断电/整机重启、跨设备 relay 或持续媒体流。面板启动与协调器进程重启已验证，不等于宿主重启已验证。

P4 尚需处理主应用看守、任务占用、维护排空、升级和恢复。不要通过上游面板自更新覆盖本集成。微信未登录、未读取数据库、未向任何联系人发送消息；P5 需要用户扫码和明确的测试会话授权。

操作入口和秘密存放位置见 [部署说明](../../deploy/cua-panel/README.md)，协议和 Master 恢复见 [协调器说明](../../integrations/cua-master-sync/README.md)。
