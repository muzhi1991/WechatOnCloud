# Linux 微信内置浏览器：入口和打开 URL 验证

日期：2026-10-30。目标：现有 P5 微信测试实例 `77bafd5161`（Cua 受管入口 `direct:192.168.31.101:13341`）。本次只调研，不新增 daemon/API/Skill 功能；未发送消息、修改微信程序、注入进程或重启容器。

## 已验证结论

**可以打开指定网页，无需先逆向调用内部接口。**

1. **不依赖分享文章的入口已验证**：点击微信主窗口左侧的“搜一搜”（星芒状图标），打开独立微信浏览器的搜一搜首页。也可以点击聊天内的公众号文章卡片打开浏览器。
2. 点击顶部文章标签右侧的 **放大镜**。它并非只能搜索：展开的输入框提示 **“在搜一搜中搜索，或输入网址”**。
3. 输入或粘贴完整 URL，按 Enter。浏览器会新建标签页打开该地址。

这是本机当前版本的实测入口。一次 `Ctrl+L` 测试没有展开地址输入框，不应套用普通 Chrome 的地址栏快捷键。右上角“…”是网页功能菜单，其中有“复制链接”“用默认浏览器打开”“浏览记录”等；“用默认浏览器打开”会离开内置浏览器，不是这里需要的入口。

本次验证：

| 验证 | 结果 | 私有证据（ignored artifacts/wechat-browser-research） |
| --- | --- | --- |
| 点击“李牧之”新分享的公众号文章 | 独立 WeChatAppEx 窗口正常显示文章 | article-open.png、browser-windows.json |
| 点击顶部放大镜 | 显示可输入网址的输入框 | search-physical-screen.png |
| 输入 `https://example.com` 并回车 | 新标签页加载 Example Domain | test-url-screen.png、generic-page-state.json |
| 原文章菜单复制链接 → 顶部输入框粘贴 → 回车 | 新标签页加载同一篇公众号文章 | article-url-navigation.png、article-url-loaded.png |
| 系统结构读取 | 浏览器窗口可读到 entry、按钮、document web 和示例网页段落 | generic-page-state.json |

用户分享文章标题为《智能算力全球第二！一张全国网，重塑生产与生活》。不在公开文档记录消息记录或带参数的分享 URL。测试结束关闭示例及重复标签页，保留原文章窗口，并显式释放 WOC 写锁。

## 程序组件与静态检查边界

当前主程序与此前分析的 Linux 微信 4.1.13.26 ELF 哈希一致：

- 主程序：`/config/wechat/opt/wechat/wechat`
  - SHA-256：`2749535f299ba67feb8ef80cab898bb0531fa8f376b16f8a72db706811c84132`
- 内置浏览器：`/config/wechat/opt/wechat/RadiumWMPF/runtime/WeChatAppEx`
  - SHA-256：`75549c42a6f155c752ca7a413942f544d15aff9f44b2ece327cd047b5de71b81`

包内 desktop 文件声明 `Name=WeChatAppEx`、`Comment[zh_CN]=微信浏览器`、`NoDisplay=true`。其 Exec 指向包标准路径 `/opt/wechat/RadiumWMPF/runtime/WeChatAppEx`；WOC 将包解压在 /config/wechat，不能据此直接假定标准路径存在或此 desktop 文件已注册到系统。

运行时窗口枚举确认浏览器属于 `com.tencent.wechatappex` / WeChatAppEx（本次 PID 80701），主微信 PID 80625；不能将这些 PID 固定写入后续实现。

基础静态字符串检查找到 `open_url_with_xweb`、`xweb_call_open_url`、`OpenUrlWithExtraWebview` 等候选名称，以及浏览器内的 XwebUse/CDP 相关字符串。这只能证明二进制包含相关标识，**不证明它们是可从外部调用的 CLI、HTTP 或稳定协议**。未据此执行猜测参数、启用调试端口、加载 hook 或注入进程。

REA 诊断显示当前 Node 补丁版本、JAVA_HOME/注册及分析引擎未满足其要求；未修改环境安装工具。此次使用包文件/ELF 字符串与真实 UI 证据，**没有完成反编译调用链或命令行 URL 接口验证**。UI 路径已解决本次核心问题，无需为此扩大逆向范围。

## 后续封装建议（未实施）

- 客户端 workflow 负责：取得 WOC 写锁 → 找到微信浏览器窗口 → 展开网址输入框 → 填入用户授权 URL → Enter → 验证新标签和页面 → 释放锁。
- 如果浏览器窗口不存在，点击微信主窗口左侧“搜一搜”即可打开，再走顶部网址输入流程。**不需要先找历史文章，也不需要给任何联系人发送链接。** 微信主程序未登录/未启动时另行返回前置条件；本次不负责自动登录。
- 短操作可按既有约定考虑放到 daemon 的应用专属能力中，复杂定位与分支仍在客户端 Skill/脚本；本次不改变接口或锁职责。
- 浏览器可以通过 AT-SPI 暴露输入框与网页结构，优先使用新鲜结构引用和明确窗口，不把此次屏幕坐标固化成长期接口。
- 注意不同 Cua 调用的截图缩放：本次桌面实际 1228×702，旧 computer_screenshot 输出长边 1200；跨独立 MCP 进程不能依赖前一进程的缩放缓存。正式脚本应使用同一会话、原生窗口截图与绑定引用。

## 未验证项

- 本次证明的是用户提供的公众号文章及普通 HTTPS 网页可以打开；未证明任意“只能在微信打开”的业务链接都兼容 Linux。需要手机环境、账号授权或特定微信能力的页面仍需用具体样本验证。
- 未验证小程序 URL Scheme、支付、登录授权、视频号或其他业务跳转。
- 浏览器窗口关闭后的 UI 启动入口已经验证；未验证 WeChatAppEx 所有后台进程均退出时的独立可执行文件启动、命令行传 URL 或外部 IPC。
- 系统结构读取只验证了本次浏览器页面，未证明所有网页、iframe、验证码或动态内容均可完整读取。


## 补充：没有浏览器窗口时直接打开（同日实测）

用户进一步要求排除“先点别人分享文章”的依赖。本次先通过右上角关闭浏览器窗口，随后窗口枚举只剩主微信 `wechat`，没有可见的 WeChatAppEx 窗口。检查主微信左下角菜单未见浏览器专用项，再点击左侧星芒形的“搜一搜”入口，即新建了 WeChatAppEx 窗口，首页显示搜一搜。

然后点击**顶部标签右侧放大镜**（不是网页中央的搜索框），输入 `https://linux.weixin.qq.com` 并回车，在新标签页成功显示“微信 Linux 版”官网。

- 无浏览器窗口证据：`no-browser-windows.json`、`main-no-browser.png`。
- 点击侧栏后窗口证据：`search-windows.json`、`sidebar-search-screen.png`。
- 顶部输入框及网址导航证据：`direct-address-screen.png`、`direct-url-result.png`。
- 最后保留“搜一搜”和官网标签供人工查看，已通过 `direct-release.json` 确认写锁释放。

因此后续客户端脚本可以直接执行“微信主窗口 → 搜一搜 → 顶部网址输入框 → URL → Enter”。现有 UI 已满足这一需求，本次没有再运行裸 WeChatAppEx 或试探启动参数。这里的“直接打开”指微信运行且已登录、浏览器窗口不存在的情况；后台 WeChatAppEx 进程此前仍在，不能把本次结果描述为彻底终止浏览器进程后的独立进程冷启动。

## 实施与验收：客户端 open-url（2026-10-30）

以上章节记录首次调研。本节为随后经用户确认实施的结果。

### 入口与职责

```sh
python3 integrations/skills/woc-wechat/scripts/wechat.py \
  --config PRIVATE_CONFIG --machine MACHINE_ID \
  open-url --url 'https://mp.weixin.qq.com/s/ARTICLE_ID'
```

| HTTP 操作（`/api/integrations/wechat/:machine/`） | MCP 工具 | 权限 / 行为 |
| --- | --- | --- |
| `browser_state {}` | `woc_wechat_browser_state` | 无锁读；返回 `open`、`documents`（title/url/busy/document_id）、dialog、60 秒调用者绑定的 window_ref |
| `navigate {page:"web_search"}` | `woc_wechat_navigate` | 写锁；聚焦唯一主微信窗口，点击侧栏“搜一搜”，不等待网页加载 |
| `browser_open_url {window_ref,url}` | `woc_wechat_browser_open_url` | 写锁；验证窗口引用，聚焦内置浏览器，展开/填入顶部原生输入框，核对内容后回车 |

- Skill 脚本负责锁、浏览器是否存在的判断、前置导航、有限次数只读观察及 finally 释放。正常路径无需 Agent 逐步找按钮；异常交给 Agent/Cua。
- 网关只沿用共享 `ui-contract.mjs` 注册、鉴权和写锁检查。MCP 同一契约自动注册新工具；没有改原始 Cua MCP 或 Skill。
- daemon 新增独立 `wechat_browser.py`，只提供原子操作，不反向调用网关，不获取锁，不自动执行缺失的前置步骤。部署同时更新 installer/init/可选镜像文件清单。
- 识别同用户 WeChatAppEx 主进程和 AT-SPI 服务，不硬编码 PID。引用绑定进程启动时间、服务、窗口和树节点；不能跨调用者或跨窗口重建使用。
- 浏览器结构遍历止于 `document web`，不从网页内挑选地址输入框。单窗口之外、多义窗口、未知弹窗、已有地址草稿和过期引用均要求调用者处理。支持 HTTP(S)，URL 上限 8192 字符，不支持文件或 JavaScript 等 URL Scheme。
- 顶部输入框收起时可能仍有旧尺寸，也可能是零尺寸；根据原生父控件和新观测展开。地址建议是输入框下方的原生无标题浮层，需要与真正的额外窗口区分。

### 验收结果

在 P5 微信测试实例 `77bafd5161` 上，通过真实客户端脚本、WOC MCP 和原始 Cua 调用验证：

1. 已有浏览器：脚本直接打开微信 Linux 官网新标签，读到新文档和标题，自动释放锁。
2. 无浏览器窗口：用 Cua 在持锁期间关闭窗口、交回控制，再运行脚本；脚本自动通过“搜一搜”建立窗口并打开目标网址。
3. 用户从“李牧之”分享的公众号文章：从现有本地消息查询获得 URL，通过脚本打开；截图确认《智能算力全球第二！一张全国网，重塑生产与生活》正文可见。最终还验证了“无浏览器窗口 → 脚本启动 → 此公众号 URL”的完整路径。未发送聊天消息。
4. 真实 MCP SDK 客户端发现新工具；无锁读取成功、无锁写入返回 `WOC_LOCK_REQUIRED`、错误窗口引用返回 `WOC_UI_STALE`、持锁打开网址成功并释放。错误保留在模型可见的 MCP 返回中。
5. 本地 Python 26 项测试通过，包括调用者绑定、引用类型/过期、非法 URL、空尺寸输入框、地址建议浮层、已有草稿保护、缺失窗口分支、不确定结果不重试、读取旧文档不算新导航、finally 释放。网关 business 3 项、真实 MCP SDK 集成测试、服务端 TypeScript 检查和 Skill 校验通过。

真实测试中修复了现有 `Desktop.click` 的一个问题：`xdotool mousemove --sync` 在鼠标已经位于目标点时会等待超时。改为同一 xdotool 调用中依序发送 mousemove/click；此前的超时由网关按规则阻止后续写入，经确认画面未提交网址后使用现有管理员 control/recover 接口恢复，没有绕过锁。临时诊断代码未保留在正式代码中。

### 返回值的限度

`url_submitted` 只代表输入框内容核对并提交；`new_document_observed` 只代表观察到新文档，**不是文章内容可访问的判定**。公众号加载中可能短暂显示“微信公众平台”，后续才变为文章标题；需要阅读正文时继续用 `browser_state` 或 Cua 查看。登录/验证/错误页不会被脚本自动处理。

微信可能给 URL 追加会话参数。因此返回原始 `requested_url_matches`，不强行将追加参数或重定向判为打开失败。原始 URL、查询结果、截图只放私有 artifacts，不提交到代码库或公开报告。脚本未建立下载、抓取正文、绕过验证码等能力。

### 部署与回退

- 面板镜像：`local/woc-panel:browser-open-url-v1`，`sha256:6791471ddc43e735df41d60f952a3f081e920be2443a1b43930f6f309737ac5f`。相对上一版只增量替换接口契约，保留现有前端。统一 compose `.env` 已固定此镜像。
- 更新微信容器内 `/config/woc-read` 与 `/opt/woc-read` 的模块及初始化脚本；只重启 `woc-read` 服务。应用容器、微信进程、独立 Cua 容器没有重建或重启。
- 部署前备份在 Docker 主机 `/root/woc-ui-private/browser-open-url-v1`。回退面板使用备份 `panel.env`（上一版镜像 `sha256:17207f63de0820d0be01ee6f50887613edb381da960e0785c9cf5492016a357f`）；回退 daemon 将备份的 ui_service.py / wechat_ui.py 恢复到两个模块目录，再只重启 `woc-read`。保留私有配置、密钥和发送收据库。
- 可复查的私有证据：`artifacts/wechat-browser-implementation/workflow-existing.json`、`workflow-launch-fixed.json`、`workflow-article.json`、`mcp-acceptance.json`；截图在 `artifacts/wechat-browser-research/impl-*.png`。不把这些原始数据加入 Git。
