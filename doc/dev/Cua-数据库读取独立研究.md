# 微信数据库读取：独立研究与授权实验

2026-10-29 从消息监控方案拆出。按用户要求，不属于第二块实施范围；本文件保留 2026-10-28 的研究证据，未重新验证上游版本。没有运行探测，实时读取授权预算仍为零。未来研究可行且另行授权后，只读结果可接入统一消息接口；接入不隐含自动扫描密钥或扩大权限。

## 2. wxcli 的项目范围与原理

前次工作区研究明确提到的是 [anyshu/wxcli](https://github.com/anyshu/wxcli)，固定快照 `08af894594b4afd468e23e17dbd783f15403f13b`；本次网页显示它 fork 自 `hydewww/wxcli`。此前提到的 [jackwener/wx-cli](https://github.com/jackwener/wx-cli) 本次访问仍返回 HTTP 451，无法声称核验了其最新版本。本文结论限定为可读 fork 的上述快照，不混用几个仓库或假定同名项目实现一致。[前次研究](../../../research/wechatoncloud-principles-2026-10-28.md)

该快照的读取链路如下：

1. Linux 扫描器查找名称为 wechat/weixin 的进程，读取 `/proc/<pid>/maps` 与 `/proc/<pid>/mem`，扫描可读写内存区域中的候选密钥，并与数据库 salt 匹配。它是进程内存读取路线；当前代码取首个匹配进程，没有为我们的实例提供明确 PID 绑定。[scanner/linux.rs](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/src/scanner/linux.rs)
2. 解密器以固定 4096 字节页布局执行 AES-256-CBC 解密，输出另一个 SQLite 文件；这不是微信官方查询 API。该函数未做页 HMAC 验证，不能把“解密函数没报错”当成数据完整性证明。[crypto/mod.rs](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/src/crypto/mod.rs)
3. daemon 加载密钥并维护联系人、会话等查询上下文；启动预热会访问联系人、session 和 sns 数据。直接启动完整 daemon 超出了“只验证某个测试会话”的最小范围，故不建议照搬启动。[daemon/mod.rs](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/src/daemon/mod.rs)
4. 缓存比较数据库与 WAL 的修改时间，决定复用、应用 WAL 或重新全量解密；README 提供 sessions/history/new-messages 等读取命令。研究这些实现可以指导适配器，但这些命令尚未在我们的微信版本上实测。[cache.rs](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/src/daemon/cache.rs)、[README](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/README.md)

**一致性审查发现：** 固定快照的 `apply_wal` 遍历完整帧，检查页号范围和 salt 后写入解密文件，但没有使用 `commit_pgcnt` 限定最后提交事务，也未验证 WAL 累积 checksum。SQLite 规范区分有效帧、提交边界和读事务的 end mark。推断：并发写入或 WAL 轮换时，此实现不足以保证读取的是一个已提交、一致的消息快照；这不是对当前账号数据已经损坏的结论。[apply_wal 源码](https://github.com/anyshu/wxcli/blob/08af894594b4afd468e23e17dbd783f15403f13b/src/crypto/wal.rs)、[SQLite WAL 格式](https://www.sqlite.org/fileformat2.html#wal_file_format)、[SQLite 读事务说明](https://sqlite.org/wal.html#concurrency)

我们若自行实现，需要先用合成数据验证页完整性、提交边界、WAL reset/checkpoint、截断、复制期间文件变化、多分片及失败恢复。仅比较 mtime 或对输出执行 integrity_check，不能证明它代表目标时刻的一致快照。不要把一个可查询的文件直接接成自动回复的数据源。

未知项：Linux 微信 4.1.13.26 的密钥表示、实际进程权限、数据目录/schema、消息 ID 稳定性、附件编码、轮换行为与本快照的兼容性；账号风控影响。当前均未运行验证。

## 3. 数据库限次授权与实验计划（尚未执行）

授权对象应是可查看的执行清单，不能是“你可以试试”的无限循环。建议 `ProbeGrant` 包含：实例 ID + 容器 ID/generation + 账号指纹、固定代码提交/脚本 hash、目标 PID/DB 范围、允许动作、最大尝试数、单次时间/读取字节上限、有效期、输出允许字段、保存期限、失败停止条件。账号或容器 generation 变化使授权失效。

建议把**一次尝试**定义为一次已经扣减预算的受限探测运行：最多一次目标进程内存扫描，以及授权清单指定的有限文件快照采集；不得在一次运行里隐藏多次扫描、自动重启再扫或切换其他账号。已取得副本后的离线解析和合成测试不消耗新的实时探测次数，但不得扩大获准读取内容。读到部分数据、超时或进程崩溃都算一次；不把“没成功”解释为免费重试。

执行器必须在任何实时读取前事务性、持久化地扣减次数；串行运行；同一请求 ID 重放返回既有记录，不重复执行；崩溃后预算不返还。下一次失败重试前展示本次结果、剩余预算及变更点；如果用户选择逐次确认模式，则每次都要确认。若只批准总预算且脚本/范围不变，仍不得超出累计预算。

| 阶段 | 允许工作与退出条件 |
| --- | --- |
| D0 纯研究 | 固定源码、列出读取面；合成 DB/WAL 测试；定义探测清单和输出。当前所在阶段，不触碰真实库。 |
| D1 经明确授权的单次探测 | 仅指定新实例；显式绑定 PID，禁止扫描宿主机其他进程；只读已批准路径；最小范围验证密钥候选和副本，禁止原库写入。超时/权限不足/异常立即停止。 |
| D2 离线验证 | 对已批准副本检查完整性、schema 和指定测试消息；先只输出“匹配/不匹配、条数、版本”，内容展示须在授权范围内。失败不得自动重新抓实时数据。 |
| D3 只读适配器试点 | 另行确认是否持续采集、会话范围、频率及保留期；不能由“三次探测”推导成无限监听授权。先影子验证，再考虑作为对账来源。 |

任何要求新增容器权限、放宽 ptrace/Yama、挂宿主机 PID、暂停/重启微信、注入/修改进程、扩展到更多库或账号、上传数据到外部服务的动作均不包含在普通读库预算内；需要展示具体变更和理由，再由用户二次确认。不能用加 `--privileged` 自动修复权限错误。

密钥、原始内存及明文缓存不进入日志、Git、模型上下文或常规备份。默认不保存原始内存；副本放私有目录并按用户确认期限清理。模型只看到任务所需、用户允许的数据。原库只读不代表没有隐私或维护风险。

