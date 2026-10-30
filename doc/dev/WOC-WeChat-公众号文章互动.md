# 公众号文章点赞与爱心

## 分层与接口

遵循 [应用操作开发规则](WOC-应用操作开发规则.md)。daemon 互动原子仅操作已打开文章的点赞栏，客户端负责寻找文章、打开链接、显式获取/释放写锁和结果核验。网关只做身份、ACL、锁和路由；daemon 不回调网关、不启动浏览器、不搜索作者、不滚动、不调用微信私有网络 API。

| 层 | 操作 | 语义 |
| --- | --- | --- |
| daemon / HTTP / MCP | `browser_article_state` | 无锁读取当前文章标题、稳定 URL、赞与在看状态；返回 60 秒调用者绑定的 article_ref |
| daemon / HTTP / MCP | `browser_article_react` | 写锁下核对 article_ref、expected_url，确保 `like`（赞）或 `wow`（爱心/在看）处于点亮状态；已点亮则不操作 |
| 客户端脚本 | `article-state` | 读取当前文章状态 |
| 客户端脚本 | `react-article --url URL --reaction like\|wow\|both --request-id ID` | 获锁、逐项观察/执行/只读核验、释放；不隐式打开另一篇文章 |
| 客户端脚本 | `open-article` / `read-article` / `react-article --author ... --read-first` | 搜索已关注账号、按关键词有界选文、组合原生 Cua 滚动；详见后面的扩展说明 |
| Agent + Cua | 未适配页面或需判断的异常 | 观察并处理明确的前置条件，确认目标后交给固定脚本 |

MCP 名称统一加 `woc_wechat_`；所有操作需要 `machine_id`，写操作另需 `lock_id`。HTTP 复用 `/api/integrations/wechat/:machine/:operation`，携带既有认证及控制周期。新增接口来自共享 ui-contract，未新增独立服务或任意脚本执行入口。

## 识别依据与边界

在 Linux 微信内置 WeChatAppEx 浏览器，通过 AT-SPI 读取当前 document web 的后代结构。只接受 `mp.weixin.qq.com` 文章和已知文章底栏：

- 赞：`sns_opr_btn sns_praise_btn`；`praised` 表示已点亮。
- 爱心/在看：`sns_opr_btn sns_love_btn` 且 `id=js_zaikan`；`love_btn_loved` 表示已点亮。
- 匹配唯一、可见、位于浏览器内的按钮；不能把评论区的点赞当作文章赞。状态读取不滚动、不聚焦、不续锁。
- 未点亮时调用当前按钮 AT-SPI Action 的 `press`/`click`，不用固定屏幕坐标。操作有界，沿用 3.5 秒 UI 观察预算与 5 秒 worker 截止时间。

当前文章以浏览器进程/窗口、document ID 和稳定 URL 绑定。完整 URL 仅保留 `__biz/mid/idx/sn`，短链接保留 `/s/…`；会话参数不进入对外文章状态。短链接跳转到长链接后须由客户端/Agent 核对文章，再传入观察到的稳定 URL，不猜测二者是否同一文章。

缺少文章、未知布局、多个匹配按钮、按钮超出窗口、弹窗、失效引用或文章切换会明确失败。只适配文章底栏的赞与在看，不涵盖评论赞、关注、留言、转发、收藏、赞赏或取消操作。在看可能对微信好友可见，Skill 要求授权对应动作，单独“点赞”不扩大为在看。

## 重复调用和证据

复用既有 `requests.sqlite` 收据库（7 天、最多 1024 条），不增加新的无界持久存储。每项反应用 request_id 去重，哈希绑定操作类型、稳定文章 URL 和反应类型，不绑定短期 article_ref。`both` 的收据 ID 为 `ID-like`、`ID-wow`，可通过 `ui_request_status` 查询。未知/部分执行保留收据，不能换 ID 盲目重试；确认未执行的前置条件错误允许修复后再试。

客户端在每项输入后最多做 4 次只读状态核验。成功表示 UI 已显示点亮，不表示独立验证了微信服务器持久化。`both` 不是事务：第一项成功、第二项失败时返回已有步骤，不回滚第一项。

## 部署与回退

自用部署日期：2026-10-30。只更新微信实例的 ui_service.py/wechat_browser.py 并重启 woc-read；不重启微信、桌面容器或独立 Cua 容器。新增代码放在已有模块，安装器/镜像原有模块清单仍覆盖全部实现。

网关镜像 `local/woc-panel:article-reactions-v1`，固定 ID `sha256:ef7a9d39c601d71523451124063b01b3b0e645782186ba2c14ebea666f17a09d`；基于原面板镜像，仅更新共享 UI 契约。同步 Agent 容器的契约副本及 `/opt/skills/woc-wechat`；已有 MCP 进程需重新连接才会重新列出新工具，新会话自动加载。

回退备份位于 Docker 主机 `/root/woc-ui-private/article-reactions-v1`：恢复 panel.env（原镜像 `sha256:068e9ab58e3881179b20b5129b4dc71dc4cad8f64beb00cfcd45879f14ff6eaf`）并仅重建 panel；恢复两个 daemon 模块到 `/opt/woc-read` 和 `/config/woc-read` 后只重启 woc-read；恢复 Skill 和 Agent 容器契约副本。保留原配置、密钥、数据库和操作收据。旧 daemon 不支持新操作时应升级对应模块，不重建登录实例。

## 验证

- daemon 与客户端回归：33 项通过；网关业务路由 3 项通过；真实 MCP SDK 契约测试通过；Skill 格式检查通过。
- 已验证原分享文章的两项真实 GUI 点亮及结构状态变化；新 Skill 在同一篇文章上连续两次执行，分别返回 already_active 和收据 replay，未取消反应，结束后锁为空闲。
- 单元覆盖文章身份/会话参数分离、评论赞排除、已点亮不动作、文章切换拒绝、单次语义点击、引用调用者隔离、未知结果不重放、客户端失败释放及两项串行核验。网关验证无锁写拒绝、只读不注入写入控制周期、持锁转发和参数校验。
- 部署后的独立 Coding Agent 验收：在 `woc-agent` 内新建 Pi/deepseek-flash 会话“公众号点赞与爱心 · Skill 验收”，使用自身 WOC 身份与已安装 Skill。Agent 通过作者入口进入同一公众号的另一篇文章，先由 `article-state` 读到两项均未点亮，再调用 `react-article --reaction both`：赞 6→7、在看 2→3，两项 UI 状态均为 active。相同 request-id 重跑返回两项 `replayed=true`，计数和状态不变；两条操作收据均存在。独立复查截图、结构状态与 free 锁一致。实际部署网关再次验证无锁写返回 `WOC_LOCK_REQUIRED`。
- Agent 导航期间曾误开原创说明帮助页，观察后返回继续；无业务互动。并行查询收据曾收到 `WOC_UI_BUSY`，改为后续只读查询成功，没有重放互动输入。测试没有评论、关注、分享、发聊天消息、赞赏或修改服务。
- 该会话保留在控制台供复查；Agent 证据位于其工作区 `acceptance/article-reactions/`，宿主私有状态目录保存会话结果和完整 timeline。四个受保护桌面容器的 ID 与启动时间前后完全一致。
- 原始文章数据、带会话参数的 URL、运行记录和截图保存在私有验收目录，不纳入此文档或 Git。

## 已关注公众号选文与分段浏览

新增能力仍在 `woc-wechat` Skill，固定流程在 `scripts/wechat.py`：

- `open-article --author 名称 [--title 标题]`：原生联系人搜索 → 本地“公众号”分类精确匹配 → 公众号会话的“公众号主页” → 已关注主页的“文章”页。省略标题取微信原生列表第一篇；指定标题关键词按包含匹配（合并空白、区分大小写），最多查首屏加三次向下翻屏；当前屏多篇命中选最上面（列表顺序最新）的一篇，命中即打开，不继续查后续屏，找不到返回 `found=false`。不会选择网络搜索结果、关注新账号或更换目标。
- `read-article --author 名称 [--title 标题] [--duration 75]`：选文后从正文顶部开始分段滚动、暂停，总浏览预算 60–90 秒。也支持已核对的当前文章 `--url`。
- `react-article --author 名称 --read-first --duration 75 --reaction both --request-id ID`：在同一写锁内选文、浏览、核对正文结束，再执行原有幂等互动。只有明确授权的反应才可执行。旧的无 `--read-first` 调用仍兼容。

新增 daemon 原子接口 `browser_profile_state`（读）与 `browser_profile_open(target_ref)`（写）。前者核对微信原生 `SubscriptionProfile/profile.html`、`subscribed=1`、账号标识和页面标题，返回视口内的文章卡片、文章标签与几何信息；后者只在新鲜、调用者绑定的引用匹配时打开一个卡片/标签。公众号会话在原生 `ui_state` 中归类为 `official_chat`。HTTP/MCP 共用既有统一契约，网关检查写锁，daemon 不回调网关。

浏览由客户端通过原生 Cua CLI 的 `DriverService/CallTool` 调用 `get_window_state`、`scroll`，目标取自当前页面的进程/窗口，仍经受管 Cua 网关。每次先获取截图上下文、核对窗口坐标，再在正文区域滚动，重新读结构核对位移。没有新增通用坐标写接口。当前 Linux 微信一次滚轮 tick 实测约 120 px；脚本按视口选择重叠段，遇不符合预期的位移会停止，不能将该像素值当作所有版本的保证。

正文 `js_article` / `js_content` 的位置决定顶部、已滚动距离和正文结束；固定互动栏遮住的区域从可读视口扣除。到正文底部后不再滚动，在剩余预算内暂停；时间用完仍未到正文底部则返回 `WOC_ARTICLE_NOT_FINISHED`，不点赞。整个流程只持一个写锁，暂停期间只查询锁状态，不续期；失锁、页面变化或输入结果不明即停止，最终释放自己的控制周期。浏览结果仅证明 UI 滚动/停留，不证明内容理解、微信阅读计数或服务端反应持久化。

部署需要同时更新 daemon 的 `wechat_ui.py`、`wechat_browser.py`、`ui_service.py`，面板/MCP 的 `ui-contract.mjs`，客户端 Skill 与脚本。只重启读取服务及面板，不重启微信或桌面容器。回退使用 `/root/woc-ui-private/article-reading-v1` 的模块、Skill、面板环境备份；恢复原模块后重启 `woc-read`，恢复旧固定面板镜像后只重建 panel。新功能没有新增持久业务存储，继续复用有界引用和已有互动收据。


### 本次验证（2026-10-30）

- daemon/客户端 Python 44 项测试通过，涵盖正文结束、75 秒停留、失锁停止、不完整阅读禁止互动、关键词多命中选顶部、三屏上限、不选网络结果、未关注主页拒绝、引用隔离及过期；HTTP 网关测试、真实 MCP SDK 工具测试通过。
- 部署的 Pi Agent 会话 `f1816b3c-2126-425b-b974-45cb44876e73` 使用内置 Skill 和自身 WOC 身份验收：以“智能算力”找到对应文章（向下滚动 1 次）；不存在的关键词在 3 次向下滚动后 `found=false`；最新文章浏览 75.3 秒、滚动 8 次，`reached_body_end=true`。
- 接着两项互动均返回 `already_active`，没有取消/重复切换；Agent 独立读取确认 active=true，最终 MCP 锁状态 free。无真实发送消息或评论。
- 验收中的一次导航后请求返回 `WOC_UI_EXECUTION_FAILED` / `not_started`，Agent 只读观察后重试一次成功。客户端随后补上导航后等待联系人搜索页就绪的有界观察，不自动重放失败写操作。
- 补充真实回归：不存在的公众号返回 `followed_account_not_found`，关键词“乔布斯”匹配成功；无锁文章观察可用，无锁 profile 写操作返回 `WOC_LOCK_REQUIRED`。
- 四个受保护桌面容器的 ID、StartedAt 未变；只更新读服务代码和 panel 入口。当前固定面板镜像 `sha256:880e91c441cb284e20c5a368d2a95c3a5e38fc1c95a1ea08724254db5c0dee08`，Agent 挂载 Skill/MCP 契约同步更新。

长文章超过预算不点赞、失锁停止等分支由自动测试覆盖；未人为抢占真实用户会话做干扰。原生界面/网页结构变化仍会明确停止，需要后续版本适配，不能承诺任意公众号版式都受支持。
