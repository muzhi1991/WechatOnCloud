# P2 独立面板部署

此目录是 llm-server 的隔离试运行配置。不要用于接管既有 Cua worker 或把已有面板数据直接迁入。实例使用已完成 P1 验收的派生镜像，面板管理自己的新账号库和新容器。

## 目标环境

| 项目 | 当前配置 |
| --- | --- |
| 宿主 | root@192.168.31.101（llm-server） |
| 部署目录 | /root/woc-cua-panel |
| 面板容器 | woc-cua-panel-p2 |
| 面板访问 | http://192.168.31.101:36082 |
| 面板数据卷 | woc-cua-panel-p2-data |
| 新实例网络 | woc-cua-p2-instances |
| Cua 端口 | 192.168.31.101:13320–13339，仅 TCP |
| 命名空间 | woc-p2 |
| 资源上限 | 面板 1 CPU/1 GiB；实例 2 CPU/3 GiB |

`WOC_CUA_IMAGE` 使用 P1 镜像 ID `sha256:a2bc099e7d89f01eb26e9b95748f49612bb94533a923cde09685621a62233d8d`，须已存在于目标宿主。迁移宿主时应先装载相同产物并核对 ID，或改成已验证的固定仓库 digest。镜像必须带 `io.woc.cua.version` 标签；Cua 实例创建失败时不会回退上游 latest。

## 构建与启动

把 `panel/`、`deploy/cua-panel/` 和 `scripts/cua/` 按仓库目录结构同步到目标目录；排除 node_modules、dist、.env 和 secrets。随后在目标宿主运行：

```sh
cd /root/woc-cua-panel
./scripts/cua/prepare-panel.sh
docker buildx build --load --provenance=false --sbom=false \
  --build-arg NODE_IMAGE=node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  --build-arg WOC_VERSION=dev-cua-p2 \
  -t local/woc-panel:cua-p2 panel
docker compose -f deploy/cua-panel/compose.yaml up -d
```

该 Node digest 是本轮目标宿主已有且验证的 amd64 构建基础。默认 Dockerfile 仍允许上游使用 node:22-slim；其他基础产物须自行验证。

管理员用户名 `admin`。随机初始密码在宿主 `deploy/cua-panel/secrets/panel-admin-password`；同步身份在同目录 `cua-sync-token`。脚本只创建缺失文件，不覆盖已有秘密。秘密目录 0700、文件 0600。不要把内容提交或写到日志。

Compose 的 Docker socket 仅挂给管理面板，实例不挂载它。每实例 token 经宿主独立文件只读挂载到实例，由 P1 初始化服务复制为桌面用户可读。普通 API 和 accounts.json 不保存明文 Cua token。面板拥有 Docker 管理权限，因此本轮只绑定既有可信内网；拓展访问前先部署认证 TLS/隧道。

在 Mac 按 [协调器说明](../../integrations/cua-master-sync/README.md) 配置服务身份和固定 deploymentId。随后面板「新建实例」勾选「接入 Cua」，容器、图形会话和 spacesd 就绪后，卡片显示「已接入 Master」。取消勾选时保留普通 WOC 行为。

## 持久化、停机和恢复

- 面板 `/data/panel/accounts.json` 保存业务数据；`/data/panel/cua/instances.json` 保存部署身份、端口、secretRef、generation、期望状态和删除标记。一个数据目录只能运行一个面板写入者。
- 宿主 `secrets/instances/` 保存独立 token；容器的 `/config` 独立数据卷保存应用数据和 Cua 工作文件，不能让两个账号共享可写卷。
- 协调器 `state.json` 保存其登记所有权；三类状态（面板、秘密、Master ledger）需要一起制定备份。恢复同一实例与克隆账号不可混用身份。
- Cua 实例主动停止后，重启面板仍保持停止。重建保留卷、token、端口，generation 增加。删除后撤销秘密并发布 tombstone；协调器只清理对应登记。
- P2 删除后的端口保留不用，当前范围可分配 20 次新身份；满了会明确失败。P4 再加入有确认机制的回收，当前可显式扩展面板和协调器的端口范围。
- 面板 Docker 日志上限 10 MiB×3，实例 20 MiB×2。Master 健康文件覆盖写入，LaunchAgent 输出丢弃。
- P2 关闭 watchdog、卡死自愈、镜像清理，避免试运行干预其他镜像和桌面。不要点击上游「面板自更新」把集成版换掉；正式升级/回滚在 P4 验证。
- 暂停自动同步：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.woc-cua-p2.sync.plist`。这不会关闭实例或撤销已登记 token。
- 停止新面板可执行此 Compose 的 `stop`；不要用全局 Docker 清理。清理本轮测试实例时通过此面板逐一删除，再等待 Master 删除回执，最后停止协调器和面板。不要操作 `cua-worker-01` 或 P1 `woc-cua-canary-01`。

P3 之前没有人机输入互斥，人工与 Agent 必须串行操作；仅查看不同窗口并不能避免共享焦点冲突。真实聊天发送和数据库访问未纳入本轮。
