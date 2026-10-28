# Cua 集成 P4 验收记录

日期：2026-10-28。分支：`feat/cua-integration`。仅更新 llm-server 的 P3 独立测试面板与 Chromium 实例；原 Cua worker、P1、P2 容器保持原 ID 和启动时间。

## 产物

- 面板入口：http://192.168.31.101:36083 ，新增“运行记录”，可查看任务、中断、维护、备份，并执行备份、镜像回退、数据恢复和维护核对。
- 面板：`local/woc-panel:cua-p4`，image ID `sha256:1e21463e7df679eeddccc0b4d5749b9a5e803b9eb48b5e790bfaadddc3519ce7`。
- 桌面：`local/woc-cua:1.5.2-cua0.6.0-p4`，image ID `sha256:4a0b859c281fc097cc5e8d8c8b56f984e272963f41e8889eb78bbae4e0e1442a`。
- 实例：`53c41906da` / `woc-wx-53c41906da` / `P3控制验收`；Cua endpoint `http://192.168.31.101:13340`，Master 名称 `woc-p3-53c41906da`。
- [部署、备份和配套回退说明](../../deploy/cua-lifecycle/README.md)。P3 升级前面板数据及 secrets 私有快照：宿主 `/root/woc-cua-p4-preupgrade-20261028`，未提交仓库。

## 实测

| 检查 | 结果 |
| --- | --- |
| 本地验证 | server 控制权/注册表/生命周期 22 项、协调器 6 项测试通过；前后端 TypeScript、Vite 和 Linux Docker 构建通过 |
| 任务记录 | Agent acquire 返回 taskId，成功写入产生动作记录，release 后任务完成；不记录输入正文或 token |
| 显式重建 | 正在持有的 Agent 任务记为 interrupted/restart；旧 token 写入失败；generation 增长，端口、观察 token、machine-id 和工作文件保持 |
| 真实维护排空 | 用实例内 flock 暂时占住输入辅助进程，发起网页转发输入，再请求重建；旧容器等待输入完成才移除，期间新输入返回 409 |
| 主应用看守 | Agent 持有租约时关闭 Chromium，5 秒内未自动拉起；release 后恢复看守并拉起主应用 |
| 备份与恢复 | 停机生成约 70 MiB /config 备份并记录 SHA-256；恢复将测试文件还原，同时保留备份外新增文件；恢复前另存当前数据 |
| 拒绝损坏备份 | 临时修改测试备份大小后，恢复请求在修改实例前失败且未进入维护；随后还原备份文件 |
| 外部 Docker 重启 | 活动 Agent 被巡检记录为 interrupted/runtime-changed；原租约失效；恢复后新租约可用 |
| 面板重启 | 未结束 Agent 任务保留为 interrupted/controller-restarted；旧租约不续接，新申请可用 |
| 面板在备份中被 KILL | 持久化维护记录变为 interrupted，面板重启后未自动拉起停止的实例，Agent 申请被拒绝；管理员核对后仍保持停止，显式启动恢复 |
| 实际 soft watchdog | 在测试面板临时启用 60 秒巡检和低阈值；无 VNC viewer、Agent 持续续约时，真实巡检日志明确延后，容器 generation 未改变 |
| 实际 hard watchdog | 对同一测试实例临时设低 hard 阈值；任务记录 interrupted/watchdog-hard，经统一维护重建后恢复 ready |
| 真正更换镜像并回退 | 先升级到带 `/woc/p4-image-probe` 的独立派生镜像，再按备份清单回退；镜像 ID 及标记文件确实变化，数据、Cua token、endpoint 保持 |
| P3 控制回归 | 真实双 Chrome 标签页 + 官方 Cua CLI 完整通过：原生 VNC 只读、网页转发、人工抢占、Shift/CapsLock 清理、旧 token/epoch 拒绝、TTL 过期和面板重启隔离 |
| 网页备份 / 手机视口 | 真实 Chrome 登录、打开运行记录、确认创建备份并收到完成提示；390px 视口弹窗可滚动且不溢出 |
| 环境隔离 | 原 worker、P1 canary、P2 面板、P2 微信和 P2 Chromium 的容器 ID / StartedAt 前后完全一致 |

网页验收发现并修复：备份停止桌面会触发 KasmVNC 的 lastActiveAt 错误，上游整页自动刷新会丢失仍在进行的备份响应。运行记录打开或维护进行时现暂停整页刷新，关闭记录后仍保留原桌面故障恢复能力。真实备份按钮已复测通过。

结束状态：测试实例 generation=8、ready，无活动任务、无未完成维护；Mac Master 协调器 healthy，登记 1 台。

watchdog 验收后已恢复试运行原配置：周期巡检、卡死自愈、镜像清理均关闭；临时低阈值已清除。测试派生镜像保留供备份清单引用，无额外运行容器。

## 语义与边界

维护异常会保留锁，不自动重放输入。管理员结束未完成维护时，运行中的实例先重启，避免遗留安装进程继续执行；已停止的实例保持停止。任务记录表示一个租约会话，不是可自动续跑的业务工作流。原生 VNC 键鼠无逐条动作日志。

备份为同宿主的私有文件，尚未配置异机归档。恢复沿用上游覆盖语义，不能当作精确时间点还原；备份外新文件保留。面板凭证和 Cua secrets 另行备份，不包含在实例 /config 归档内。容量上限拒绝新增，不自动删历史文件。P3 镜像需要旧面板配套回退，不能通过 P4 的单实例回退按钮直接降级。

尚未进行真实微信登录、收发、群聊或聊天数据库读取；安装/更新维护入口已接入，但本轮未下载新微信版本验证安装包。P5 应使用专门测试账号/会话，先由用户扫码，再依据明确的发送授权验收。未发布公共镜像、推送分支或创建 release。
