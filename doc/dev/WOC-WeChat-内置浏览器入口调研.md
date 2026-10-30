# Linux 微信内置浏览器：入口和打开 URL 验证

日期：2026-10-30。目标：现有 P5 微信测试实例 `77bafd5161`（Cua 受管入口 `direct:192.168.31.101:13341`）。本次只调研，不新增 daemon/API/Skill 功能；未发送消息、修改微信程序、注入进程或重启容器。

## 已验证结论

**可以打开指定网页，无需先逆向调用内部接口。**

1. 在微信聊天内点击用户分享的公众号文章卡片，打开独立的微信浏览器窗口。
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
- 如果窗口不存在，先从明确指定的现有文章/链接卡片打开浏览器。这是流程前置条件，不应自动给任何联系人发送链接；也未验证浏览器关闭时的独立无参启动方式。
- 短操作可按既有约定考虑放到 daemon 的应用专属能力中，复杂定位与分支仍在客户端 Skill/脚本；本次不改变接口或锁职责。
- 浏览器可以通过 AT-SPI 暴露输入框与网页结构，优先使用新鲜结构引用和明确窗口，不把此次屏幕坐标固化成长期接口。
- 注意不同 Cua 调用的截图缩放：本次桌面实际 1228×702，旧 computer_screenshot 输出长边 1200；跨独立 MCP 进程不能依赖前一进程的缩放缓存。正式脚本应使用同一会话、原生窗口截图与绑定引用。

## 未验证项

- 本次证明的是用户提供的公众号文章及普通 HTTPS 网页可以打开；未证明任意“只能在微信打开”的业务链接都兼容 Linux。需要手机环境、账号授权或特定微信能力的页面仍需用具体样本验证。
- 未验证小程序 URL Scheme、支付、登录授权、视频号或其他业务跳转。
- 未验证 WeChatAppEx 的独立命令行传 URL、外部 IPC 或无窗口冷启动入口。
- 系统结构读取只验证了本次浏览器页面，未证明所有网页、iframe、验证码或动态内容均可完整读取。
