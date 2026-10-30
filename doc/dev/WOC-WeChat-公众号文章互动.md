# 公众号文章点赞与爱心

## 分层与接口

遵循 [应用操作开发规则](WOC-应用操作开发规则.md)。此功能仅操作已打开文章的点赞栏，客户端负责寻找文章、打开链接、显式获取/释放写锁和结果核验。网关只做身份、ACL、锁和路由；daemon 不回调网关、不启动浏览器、不搜索作者、不滚动、不调用微信私有网络 API。

| 层 | 操作 | 语义 |
| --- | --- | --- |
| daemon / HTTP / MCP | `browser_article_state` | 无锁读取当前文章标题、稳定 URL、赞与在看状态；返回 60 秒调用者绑定的 article_ref |
| daemon / HTTP / MCP | `browser_article_react` | 写锁下核对 article_ref、expected_url，确保 `like`（赞）或 `wow`（爱心/在看）处于点亮状态；已点亮则不操作 |
| 客户端脚本 | `article-state` | 读取当前文章状态 |
| 客户端脚本 | `react-article --url URL --reaction like\|wow\|both --request-id ID` | 获锁、逐项观察/执行/只读核验、释放；不隐式打开另一篇文章 |
| Agent + Cua | 从公众号作者页面选择另一篇文章等 | 需要理解页面的导航；确认目标后交给固定脚本 |

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
