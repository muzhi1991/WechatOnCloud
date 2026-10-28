# P4 生命周期试运行

本目录只升级 P3 测试环境：`woc-cua-panel-p3` 和它管理的测试实例。原 `cua-worker-01`、P1 和 P2 独立环境不变。入口仍为 http://192.168.31.101:36083 。

## 构建与部署

宿主：llm-server，目录 `/root/woc-cua-control`。先保留 P3 镜像、Compose、面板数据卷与 secrets；停止面板后备份其数据，不能复制正在写入的 JSON 充当一致备份。备份包含凭证，只存管理员可读目录。

```sh
docker build -f docker/lifecycle/Dockerfile -t local/woc-cua:1.5.2-cua0.6.0-p4 .
docker image inspect local/woc-cua:1.5.2-cua0.6.0-p4 --format '{{.Id}}'
docker build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  --build-arg WOC_VERSION=dev-cua-p4 -t local/woc-panel:cua-p4 panel
# 将 compose.yaml 中 WOC_CUA_IMAGE 固定为实际构建的 image ID。
docker compose -f deploy/cua-lifecycle/compose.yaml up -d --no-deps panel
```

面板启动不会自动升级桌面镜像。通过该面板的“升级实例”显式升级：先隔离输入、生成停机备份，再重建到固定 P4 镜像。P4 实例镜像增加 `io.woc.cua.lifecycle=1`；不能直接回退到缺少此能力的镜像继续交给 P4 管理。

试运行仍关闭实际 watchdog、卡死自愈和镜像清理，避免验收期间的后台干扰。代码已让 soft watchdog 感知 Agent 租约，hard / 无响应恢复经过维护入口。开启周期巡检前应按实际应用内存设置阈值；本轮不会修改原环境的巡检设置。

## 控制与任务

- `WOC_LIFECYCLE_ENABLED=1` 启用受管实例维护。普通 WOC 实例保持原行为。
- 重启、升级、停止、删除、安装、文件写入、主题和字体修改通过同一实例维护入口；进入后撤销租约、停止新输入、等待已有动作，操作完成并检查桌面就绪后恢复为空闲。
- hard 自愈可以中断在途动作。延迟的网页输入在真正启动辅助进程前再次检查旧控制器，不能向重建后的桌面继续输入。
- Agent 持有租约期间，主应用退出后不会自动拉起；交回控制后恢复原主应用看守。Agent 启动的其他应用不由此看守管理。
- 每个 Agent 租约有 `taskId`，相当于一次控制会话，并不是自动化工作流引擎。记录任务、网关/网页转发动作和维护结果，不保存聊天文本、RPC 参数、租约 token 或密码。原生 VNC 键鼠没有逐条审计。
- 动作响应成功才记完成；响应不确定需核对画面。面板进程重启会将未完成任务标为中断、未完成动作标为结果待核对；任何操作均不自动重放。
- 外部 Docker 重启通过容器 ID/启动时间检查发现：每次受管入口检查，活动租约另有 5 秒巡检。原租约失效，重新恢复控制服务后才接受新租约。
- 未完成维护会持久锁住输入，并阻止面板启动时自动拉起实例。管理员在“运行记录”核对后结束维护：运行中的实例先重启以终止遗留安装进程；已停止的实例保持停止，需要再显式启动。恢复动作不会替用户判定聊天是否发送成功。

## 备份与恢复

“运行记录”提供创建备份、回退镜像、恢复备份。备份停止实例后读取完整 `/config`，完成后按原状态启动；升级、数据恢复前也先备份。文件位于面板数据卷 `/data/panel/cua/backups/<UUID>.tar.gz`，权限 0600，配套清单在 `/data/panel/cua/lifecycle.json`。

清单记录 SHA-256、大小、镜像 ID、数据卷和 generation，数据 fsync 后才确认完成。恢复前验证大小、哈希和 tar 路径。单个备份上限默认 10 GiB、总量 20 GiB，保留至少 2 GiB 可用空间；可用 `WOC_BACKUP_MAX_GIB`、`WOC_BACKUP_TOTAL_GIB` 调整。达到限额拒绝新备份和依赖它的升级，不自动删除旧备份。管理员应将旧文件和清单归档到外部存储；同盘备份不能抵御宿主磁盘损坏。近期任务/动作/已完成维护保留 2000 条，未解决维护和备份清单保留。

回退镜像只重建容器，不回退应用数据。恢复数据沿用上游整卷导入语义：**覆盖备份内同名文件，保留备份外新增文件**，不是精确时间点回滚。恢复前另存当前数据；失败时不自动启动应用，保持维护供管理员检查。备份不包含容器可写层中临时安装的软件；持久软件应放进派生镜像或 `/config`。Cua 凭证和面板账号不在实例备份内，必须另备份面板卷与 secrets。

## API / Agent

人工管理员接口（沿用面板会话认证）：

- `GET /api/instances/:id/activity`：维护状态与近期记录，实例停止时仍可读。
- `POST /api/admin/instances/:id/maintenance/backup`：停机备份。
- `POST .../rollback-image` 或 `.../restore-backup`，JSON `{"backup":"备份 UUID"}`。
- `POST .../review`：核对后结束维护。

Agent 见 [CLI 文档](../../integrations/cua-agent/README.md)，新增 `history`。此服务身份用于可信 Agent 控制器，不分发给桌面内不受信任程序。

## P3 配套回退

本次升级前快照在宿主 `/root/woc-cua-p4-preupgrade-20261028`，旧镜像和原 P3 Compose 保留。不要在运行中的 P4 面板上覆盖其数据。需要退回 P3 时，先停止 P3 协调器和 Agent、停止该测试面板，备份现有 P4 数据；核对实例是否需要同时恢复升级前的 `/config`，然后使用快照中的旧面板数据、secrets 和 P3 固定镜像成套恢复。恢复旧注册表会回退 generation，需要核对协调器状态后再启动登记。不要用旧数据快照覆盖其他环境，不要全局 Docker prune。
