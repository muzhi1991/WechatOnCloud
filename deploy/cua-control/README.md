# P3 独立控制权试运行

在 P2 旁边部署新的面板和实例，保留 WechatOnCloud 网页管理和 KasmVNC 桌面，加入受管 Cua 输入与人工接管。现有 Cua worker、P1、P2 不迁移、不重建。

| 项目 | 本轮配置 |
| --- | --- |
| 宿主 / 部署目录 | llm-server / `/root/woc-cua-control` |
| 面板 / 数据卷 | `woc-cua-panel-p3` / `woc-cua-panel-p3-data` |
| 面板地址 | http://192.168.31.101:36083 |
| 实例网络 | `woc-cua-p3-instances` |
| Cua 网关端口 | 192.168.31.101:13340–13359 TCP，由面板发布 |
| Master 命名空间 | `woc-p3` |
| 实例镜像 | `local/woc-cua:1.5.2-cua0.6.0-p3`，Compose 固定本机 image ID |
| 资源上限 | 面板 1 CPU / 1 GiB；每实例 2 CPU / 3 GiB |

## 构建

目标宿主先具备通过 P1 验收的 `local/woc-cua:1.5.2-cua0.6.0-p1`，其 ID 应为 `sha256:a2bc099e7d89f01eb26e9b95748f49612bb94533a923cde09685621a62233d8d`。同步本仓库到独立部署目录，排除 node_modules、artifacts、dist、.git 和 secrets。

```sh
cd /root/woc-cua-control
./scripts/cua/prepare-control.sh
docker build -f docker/control/Dockerfile -t local/woc-cua:1.5.2-cua0.6.0-p3 .
docker image inspect local/woc-cua:1.5.2-cua0.6.0-p3 --format '{{.Id}}'
# 核对产物，更新 compose.yaml 中 WOC_CUA_IMAGE 为本机实际 ID。
docker build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  --build-arg WOC_VERSION=dev-cua-p3 -t local/woc-panel:cua-p3 panel
docker compose -f deploy/cua-control/compose.yaml up -d
```

`prepare-control.sh` 只创建缺失凭证，不覆盖已有凭证。管理员密码在 `deploy/cua-control/secrets/panel-admin-password`。本部署仍采用现有可信内网，未新增公网或 TLS 入口。

创建实例时勾选“接入 Cua”。受管实例使用 P3 镜像，**不发布原始 3211 或 Kasm 6901/3000 端口**；网关使用容器内连接。未勾选的普通 WOC 实例仍使用 P1 基础镜像，沿用原操作方式。不要将缺少控制脚本的 P2 镜像配置为 P3 受管镜像。

## Master 和 Agent

沿用 [P2 协调器](../../integrations/cua-master-sync/README.md)，以 P3 的 URL、deploymentId、namespace、sync-token 和独立 stateFile 新建配置。当前 Mac 已部署 `local.woc-cua-p3.sync`；配置在 `~/.local/share/woc-cua-p3/config.json`。自动登记凭证是只读派生 token；不得将内部 spacesd token 手工登记到 Master。

写入入口见 [受管 Agent CLI](../../integrations/cua-agent/README.md)。本机配置在 `~/.local/share/woc-cua-p3/agent.json`，凭证不入库。

## 交接与恢复

1. 新打开的网页默认只读，点击“申请控制”后才能输入；同一账号的两个标签页也互斥。
2. 人工可接管 Agent 或另一标签页。交接会撤销旧凭证、断开旧 VNC 连接、等待在途动作，然后释放所有键鼠和 Caps Lock 等锁定状态。旧标签页自动重连为只读。
3. 人工点“交回控制”，Agent 才能申请。持有者 30 秒无续约即失效。人工在可见页面每 5 秒续租；Agent 执行动作期间每 5 秒续租。
4. 动作结束无法确认时进入 `faulted`。管理员点击“恢复控制服务”，终止旧 Cua driver、清理输入后恢复为空闲；不重启 X 和应用、不重放动作。
5. 面板重启后不恢复旧租约。首个经认证的访问完成 driver 隔离和就绪检查后才允许新输入。

KasmVNC 1.3.3 的认证及 WebSocket 请求头存在大小写兼容要求，代理已规范化。服务端只读由 Kasm 权限强制执行，前端遮罩只用于提示。

此阶段的受管桌面保留 Kasm 画面和键鼠；音频 WebSocket、原生 Cua viewer/连续媒体流未接入。文件管理、主题、实例重启/升级等管理功能尚未全部纳入控制租约，操作这些功能前应先交回控制。watchdog、卡死自愈和镜像清理在试运行配置中关闭，维护排空和任务恢复属于 P4。

## 回退

停止 P3 协调器和 Agent 任务，再停 P3 面板；保留 P3 数据卷与 secrets。不要把 P3 面板直接切回 P2 镜像继续管理同一批实例：两者端口归属和凭证语义不同。P2 独立环境始终保留可用。若清理本轮测试实例，通过 P3 面板删除，并让 P3 协调器完成注销；勿使用通配符批量删除 Docker 资源。

网页转发输入的辅助进程也受容器内文件锁保护，单次命令限制 15 秒，交接／恢复必须等它退出。受管模式取消 WOC 原有的“一秒后自动归还剪贴板”：转发输入后剪贴板保留本次文字，避免交接后发生旧任务的延迟写入。普通未受管实例保持原行为。
