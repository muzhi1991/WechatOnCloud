# 微信 UI 原子接口与客户端 Skill：首版验收

日期：2026-10-30。对象：现有 Linux 微信 4.1.13.26，机器 `77bafd5161`。本轮新增应用 GUI 能力，不改变 wx-cli 只处理数据库及本地文件的职责。前期机制调研见 [调研记录](WOC-WeChat-UI-原子操作调研.md)，整体拓扑见 [架构文档](WOC-Cua-系统架构.md)。

## 实现边界

```text
Agent → woc-wechat Skill 脚本 → 认证 HTTP → 原 WOC 面板网关 → woc-daemon → 微信 UI
Agent → 同一个 WOC MCP      → 认证 HTTP → 同上
Agent → 原 Cua MCP          → 每机器独立网关端口 → 原 cua-spacesd
```

三条链共用原来的机器身份、访问范围和 GUI 写锁。锁由客户端显式获取/释放；网关只检查，daemon 不反向请求网关、不自动获锁、不编排前置步骤。原 Cua MCP、Skill 和 cua-spacesd 不修改。容器服务仍是内部 HTTP 3212，不新增容器 MCP。网页原人工输入功能保持原逻辑。

客户端固定流程放在 [wechat.py](../../integrations/skills/woc-wechat/scripts/wechat.py)，用 if/else 调用原子接口；[woc-wechat/SKILL.md](../../integrations/skills/woc-wechat/SKILL.md) 指定脚本入口。需要观察消歧或尚未支持的界面交回 Agent/Cua。没有自动回复、视频下载编排或服务端长流程。

## 接口

HTTP 为 `POST /api/integrations/wechat/:machine/:operation`；对应 MCP 工具为 `woc_wechat_<operation>`，增加 `machine_id`。契约见 [ui-contract.mjs](../../panel/server/src/business/ui-contract.mjs)。

| operation | 关键参数 | 行为及权限 |
| --- | --- | --- |
| ui_state | 无 | 读；返回 app、page、dialog、data、available_actions |
| navigate | page | 写；进入 conversations / contacts / favorites，不隐式寻找聊天 |
| ui_search | scope、query | 写；当前会话页或联系人页搜索；范围不匹配则返回前置条件 |
| open_item | target_ref | 写；打开当前观察中的明确项，包括会话、联系人资料或“发消息”入口 |
| fill_text | expected_chat、text、可选 expected_draft | 写；聊天及原草稿匹配后填入文本，默认要求原草稿为空；不发送 |
| send_draft | expected_chat、expected_text、request_id | 写；再次校验聊天和草稿，点击发送；返回本地执行证据 |
| ui_request_status | request_id | 读；查询本身份保存的发送执行记录，不代表送达或已读 |

写工具可传 `lock_id`，映射为 HTTP `X-WOC-Expected-Epoch`，拒绝旧获锁周期的请求。客户端脚本始终带上它。原 Cua 请求保持原协议。所有读取不申请、不续期 GUI 写锁。

`target_ref` 绑定调用者、微信进程、AT-SPI 服务及节点语义，60 秒过期，操作前重读校验。不是永久联系人 ID。错误保留 `code/error/execution` 及已有 `precondition` 等字段，MCP 同时返回 JSON 文本、structuredContent 和 isError。结果为 partial/unknown 时不自动重试；明确 not_started 的前置条件错误不把控制权标成执行未知。

## 页面与查找策略

`ui_state` 支持识别 chat、conversations、contacts、contact_profile、search_results、favorites、official_accounts；未知页面返回 unknown。各页面 data 不同：聊天带标题和草稿，列表带可操作项，搜索带范围和分类，收藏带可见标签，公众号当前仅确认页面标题，正文操作明确未支持。朋友圈等未完成适配，不能因为导航栏有入口就声称当前位于该页面。

查找规则已写入 Skill 和代码：

1. wx-cli 解析精确 username 和可搜索显示名；检测同类同名候选。
2. 当前已经打开目标聊天则复用；当前可见且唯一的目标直接点开。
3. 否则，sessions/groups 来源进入会话页搜索，contacts 来源进入联系人页搜索。无需逐屏翻会话或通讯录。
4. 搜索结果区分本地联系人、群聊、聊天记录、网络等类别，只打开支持的本地对象。文件传输助手属于“功能”分组，以 system_chat 单独识别，只允许该明确入口。
5. 联系人资料页通过当前明确“发消息”项进入聊天；重新观察标题和草稿后才继续。找不到、同名、弹窗或状态不符就返回给 Agent。

数据库 username 用来选定目标，但 UI 目前只能核对显示名，返回 `identity: unique_display_match`，不是已从 UI 验证内部账号 ID。存在同名、别名不同或未命名群时需要进一步身份判断。搜索分组、页面标签针对当前中文 Linux 微信验证，其他版本/语言需重新验收。

## 底层执行和可靠性范围

微信适配器用 AT-SPI 单项属性读取结构，禁止调用历史上导致微信断连的 GetAll。实际输入沿用 WOC 的可行机制：固定 argv 调用 xdotool/xclip，以剪贴板粘贴中文；发送前检查前台进程、页面、聊天、原草稿和发送按钮。没有调用微信内部发送协议，也不能保证无焦点输入。粘贴会改变剪贴板。

每个 worker 最长五秒，不等待内部任务队列。写入使用已有 HTTP input fence，在人工接管前排空本地输入；该 fence 不承担客户端所有权管理。daemon 不持有长期客户端凭证、不做网络回调。未知覆盖窗口会阻止写入。

发送记录位于私有 `private/ui/requests.sqlite`，上限 1024 条、七天保留（过期记录在后续发送请求时清理）；维护时保留该文件，服务重启后仍可识别重复请求。先持久记录可能执行，再派发发送；相同 ID 和参数返回旧结果，改参数则报冲突。明确未执行的失败可在修正前置条件后重试，partial/unknown 不重放。过期之后不再承诺去重，调用者不能把旧任务当新任务重发。

## 实测结果

所有 GUI 写入均经过受管网关及客户端显式获锁。部署用 SSH 更新代码，不把 SSH 作为 GUI 输入旁路。

| 场景 | 结果 |
| --- | --- |
| 当前可见会话直接打开 | 通过，客户端报告 visible_item，不搜索、不滚动 |
| 联系人页搜索李牧之 | 通过，选本地联系人类别 |
| 会话页搜索李牧之 | 通过，忽略同名历史/网络结果 |
| 联系人列表→资料→发消息→聊天 | 通过 |
| 群聊打开 | 通过，校验群名与编辑框标签；没有向群发送消息 |
| 文件传输助手搜索 | 补上“功能”类别；验证搜索打开，拒绝其他功能/历史/网络同名项 |
| 收藏、公众号页面识别 | 通过；公众号正文仍不支持 |
| 无锁 UI 写请求 | 真实 MCP 返回 WOC_LOCK_REQUIRED；无 GUI 输入 |
| 不持锁读取 UI | 真实 MCP 返回当前页面；原 Cua MCP 窗口枚举仍正常 |
| 持锁但聊天不匹配 | 真实 MCP 返回 WOC_CHAT_MISMATCH、not_started 及完整前置条件，无输入，随后释放锁 |
| 旧 epoch、参数越界、不同机器 ACL | 网关测试拒绝，不派发 |
| 同一 request_id 重复提交 | 返回旧记录，不再填草稿或发送；服务重启后仍有效 |

本轮新接口发送两条授权测试消息：

- 李牧之：`WOC 原子接口发送验证（客户端脚本）`。
- 文件传输助手：`WOC 搜索与发送接口验证（文件传输助手）`。

两次均由已安装 Skill 的实际客户端脚本经生产 HTTP 链完成，草稿清空，随后数据库各找到一条对应记录。首次数据库读取可能还没有 checkpoint 后的新记录；没有因此重发。这些证据证明本地 UI 执行及本地消息记录，不证明对方送达/已读。此前调研阶段另有两条原 Cua 测试消息，不能与本轮混为新接口测试。

自动化回归：Python 19 项（含客户端流程、分类、草稿防覆盖、请求去重/重启）；网关业务 3 项、既有控制 25 项；真实 MCP SDK 客户端测试 1 项；TypeScript 编译检查及 Skill 格式验证通过。单元测试覆盖人机交接/旧周期等已有锁约束；本轮没有在真实消息发送中故意制造人工抢占或网络断连。

## 部署与回滚

统一控制台仍为 `192.168.31.101:36083`，Cua 三端口 13340/13341/13342 不变。面板镜像：

- `local/woc-panel:wechat-ui-v2`
- `sha256:1713435394a4edef84369e166d338df7548f1349e1a455a27c18178aa0e34f26`

原微信容器没有重建，仍是 `sha256:4a0b859c281fc097cc5e8d8c8b56f984e272963f41e8889eb78bbae4e0e1442a`；仅更新 `/opt/woc-read` 与 `/config/woc-read` 下三模块及初始化脚本，私有 config 显式 `ui.enabled: true`，重启 s6 `woc-read` 服务。微信 PID 保持 80625。浏览器、微信、完整桌面、独立 cua-worker-01 容器 ID/StartedAt 前后不变。

可选的新实例镜像 `local/woc-cua:read-ui-v2`（`sha256:fc9a02599cc928c99134a165818f3c7936903df855dd30cb5a51a7224cd1ab6b`）包含三模块和 initializer；账号、密钥、凭证、wx 二进制及启用配置仍需单独提供，镜像不含这些数据。现有实例未切换到此镜像。

Mac 上 `~/.codex/skills/woc-wechat` 链接仓库 Skill；WOC MCP 使用原启动配置，重新连接后可发现新工具。没有新增 MCP 进程。原生 Cua 连接与机器同步配置不变。

代码更新前的私有备份 `/root/woc-ui-private/before-v1/` 保存旧 server.py/config.json、panel.env、受保护容器状态和微信 PID。局部回滚方式：先确认无写任务，停 woc-read，恢复旧 server.py/config.json（persistent 与 packaged server 一致），重新启服务；面板恢复备份 panel.env 并从唯一 unified compose 目录重建 panel。保留私有密钥、缓存、导出及发送记录，不回滚微信数据卷、不重启微信或其他容器。新 MCP/Skill 在旧 API 下停止使用 GUI 操作即可。

原始截图、结构、真实消息与回执证据放 ignored artifacts，仅提交代码、脱敏行为记录和文档。没有提交凭证、密钥或聊天快照。
