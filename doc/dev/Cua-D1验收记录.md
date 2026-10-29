# D1：并行完整桌面模式与应用行为隔离

日期：2026-10-29。基线 `9c4d078`。状态：**独立测试部署的桌面基本功能、受管 Agent、数据恢复、浏览器全屏/鼠标捕获已验收；过夜稳定性待补验，未发布正式 release。**

## 部署与隔离

面板入口：`http://192.168.31.101:36084`，主桌面：`/i/5d8379ca7b`。部署说明见 [deploy/desktop](../../deploy/desktop/README.md)。新面板使用原管理员登录密码，但拥有独立的同步/Agent 凭证、数据卷、网络和网关端口；秘密均在仓库外或 ignored secrets 目录。

| 对象 | 实例/容器 | 用途 |
| --- | --- | --- |
| 新面板 | `woc-desktop-panel-d1` | 36084，独立部署 |
| 主桌面 | `5d8379ca7b` | 多窗口、中文、升级持久化、双页面 |
| 应用对照 | `0d8d2f1be2` | 原 P4 Chromium 应用模式 |
| 全新桌面 | `c86fb1ebe5` | 网页创建、空白卷、Agent、备份恢复、重启 |

桌面最终镜像：`sha256:ce67703372b350bd63a9642a52e78a3daff2b34e752f588ec29656557c7e4f05`。

面板最终镜像：`sha256:0b515ecc33a94903be3581753e956ee28275fd4fa67b0a9319345e8e62377d5e`。

应用/P4 固定底座：`sha256:4a0b859c281fc097cc5e8d8c8b56f984e272963f41e8889eb78bbae4e0e1442a`。

桌面包：tint2 `17.0.1-1`、PCManFM `1.3.2-1`、Openbox `3.6.1-10`、xterm `379-1`；系统为 Debian 12。构建脚本先检查基础 tag 的实际 image ID，桌面部署配置只接受 ID/digest。

现有 `woc-wx-77bafd5161`、`woc-cua-panel-p3`、`woc-wx-53c41906da`、`woc-cua-panel-p2`、`woc-wx-768c59bc63`、`woc-wx-0bd47b675b`、`woc-cua-canary-01`、`cua-worker-01` 的容器 ID 与 StartedAt 均与实施前一致。没有重启这些容器、操作其登录会话、查询微信数据库或发送消息。

## 代码边界与上游合并

完整桌面的 init、autostart、session、launch、Openbox 菜单和 tint2 配置放在 `docker/desktop/`；镜像选择/模式校验放在 `panel/server/src/desktop.ts`；独有网页按钮放在 `panel/web/src/DesktopControls.tsx`。管理页只加模式选择，公共查看器按模式调用独立组件。

原 WOC `docker/autostart`、身份脚本、主应用初始化、应用安装器没有修改。派生桌面镜像删除 `00-woc-identity`、`01-woc-autostart`、`02-woc-app` hook，并提供自己的启动入口，避免依赖对上游脚本正文的字符串替换。

| 分类 | 决策与原因 |
| --- | --- |
| 通用桌面基础 | 保留 KasmVNC/Xvnc、Openbox、D-Bus、Cua、中文字体、正确 DPI、输入/剪贴板兼容修复 |
| 公共管理接口 | 保留实例身份、网络、凭证、资源上限、受管控制、文件/字体/壁纸、备份和回滚；各实例的可写卷和状态独立 |
| 应用模式策略 | 桌面不运行主应用等待/自动重拉、不强制恢复最小化、不继承浏览器强制最大化参数 |
| 微信环境处理 | 桌面不伪装 deepin、设备品牌 hostname/MAC，不删除 `/.dockerenv`；自己的 machine-id 按数据卷持久化 |
| 应用自动恢复 | 桌面缺省内存软/硬重启阈值为 0；连接失败 heal 不重建，HTTP 健康失败看守跳过桌面；用户显式维护仍可用 |
| 通讯应用 | 仅菜单显式调用安装/启动适配器；桌面启动时没有必选主应用，也不自动安装微信 |
| 输入和显示 | 桌面自动回车独立偏好且默认关闭；使用本地缩放；HTTP 下不启用依赖安全上下文的无感剪贴板 |

这不是完全独立的二进制底座：首版仍继承固定的 P4 系统包和通用修复。应用镜像升级不会自动推进桌面镜像。未来升级底座需单独构建/回归；若要拆到通用基础镜像，可以沿用当前 mode、镜像和 session 接口，不必重写面板。

API 暂时保留兼容字段 `wechat` 表示实例就绪状态，桌面分支实际检查 Openbox/tint2/xsettingsd 是否运行，不再以启动脚本文件存在当作就绪。旧记录默认 `mode=app`；首版禁止桌面复用应用卷、运行中切换模式、跨模式镜像重建或回滚。镜像模式在备份/移除旧容器前预检。

## 通过的验证

- 前后端 TypeScript 检查、Web 构建；desktop 4、cua 4、control 15、lifecycle 3，共 26 项测试通过。
- 创建 API 拒绝未知模式、桌面复用旧应用卷。网页创建弹窗能切换模式；完整桌面隐藏主应用选择，自动启用受管 Cua。
- 网页新建 `c86fb1ebe5` 的空白卷启动成功；没有 `/config/.woc-app`、没有微信安装目录；两个桌面与应用对照分别使用独立卷和网关。
- 真正显示普通桌面任务栏、菜单、时钟，打开 PCManFM、xterm、Chromium 多窗口；拖动窗口、最小化并从任务栏恢复；浏览器正常关闭后未被重拉。
- 文件管理器地址栏通过网页输入条填入“完整桌面中文输入验收”，未自动按回车；没有 Kasm 剪贴板异常。
- 桌面 XSETTINGS 为 `Xft/DPI 98304`；同一 profile 的裸 Chromium 无 scale flag 连续两次存活 8 秒。
- 两个页面查看主桌面，其中一页调整为 900×700；旁观页面仍只读，远端 X 分辨率保持 1024×768；测试后撤销页面尺寸覆盖。
- 新实例自动登记 Master。受管 Agent 取得租约后打开 PCManFM、截取完整桌面，并通过像素双击进入 `/config/workspace`；网页画面核实结果。
- 人工接管 Agent 后旧租约续租返回 HTTP 409；人工持有时 Agent acquire 返回 409；人工交回后 Agent 可重新申请并释放。
- 主桌面从早期原型升级为独立 session 后，`/config/workspace/desktop-persist.txt` 保留。
- 全新桌面受管备份：`c0630a9f-dc2a-4173-bdb8-850c20c0d99d`，1,913,669 字节；修改测试文件后恢复备份，内容回到 `desktop-backup-before`，machine-id 与镜像一致。随后显式重启仍沿用镜像/身份/文件，tint2 与 xsettingsd 各只有一个进程。
- 应用对照仍使用原 P4 image ID，StartedAt 保持 `2026-10-29T01:28:58.148571305Z`；网页保留原应用工具栏、自动回车默认值及 `resize=remote` 行为。

## 验收中修复与限制

1. 独立 session 最初因 root 创建的 `/config/.local/share` 不可写而提前退出，导致任务栏缺失。将生成目录属主和需 root 的字体配置恢复放入 init；已分别验证升级卷、全新卷、备份恢复和重启。
2. 局域网 HTTP 下强制 seamless clipboard 会触发 `ClipboardItem is not defined`。桌面 URL 按浏览器能力关闭 seamless 模式，保留显式面板输入/剪贴板；相同中文填入动作已通过。
3. 早期测试卷从伪装 hostname 切到固定 `desktop-ID` 时，Chromium 提示旧主机名的 profile 锁；通过该测试浏览器自身“Unlock Profile and Relaunch”解除。正式空白桌面从创建起就固定 hostname，不迁移原微信卷。
4. PCManFM 在本次 Cua 版本中返回 AT-SPI 降级的窗口元数据；已验证截图/像素操作，不能把它描述成所有应用都支持完整辅助功能树。
5. 网页输入条沿用 Ctrl+V，xterm 的粘贴键不同；可通过「剪贴板」后在终端按 Shift+Insert，不改终端 Ctrl+V 的原始语义。

## 补验与后续边界

- **全屏/鼠标捕获已补验**：用户解锁 Mac 后，通过前台 Chrome 成功进入完整桌面全屏，Esc 返回面板；捕获鼠标后出现浏览器原生提示，按钮变为“释放鼠标”，Esc 可退出。再次捕获后焦点转入地址栏，自动释放；捕获期间重建本次新增的测试面板，VNC 断线后自动释放，重连恢复只读；捕获期间通过网页「交回控制」也自动释放鼠标并恢复只读。后台被拒绝时有提示且不会出现 Kasm fatal overlay。
- **过夜稳定性**：已启动下述只读采样，首个样本正常；尚未达到过夜时长，不能声称已过夜通过。
- 可选微信/QQ/Telegram 菜单适配器未在新桌面安装或登录验收；本轮核心桌面不依赖这些应用。后续按需独立验收，不借此进行数据库试探或发消息。
- AI 对话控制台、模型 API runtime、监控与自动回复均不在本次提交。

测试副本保留供查看。回滚只停用本次新增面板/实例并保留卷；不修改 36083 原面板和旧 Cua/微信容器。正式发布仍需完成过夜检查。

## 过夜采样与复查

2026-10-29 10:09:26（Asia/Shanghai）启动 llm-server 的 `woc-d1-soak-20261029.service`，计划采样 36 小时，间隔 300 秒，服务最长运行 37 小时。首样本无探测错误或不健康项。原 P5 采样任务未修改。

范围为新增面板与三个新实例的容器状态、资源和身份，以及主桌面的网关健康、登记、控制状态和 Openbox/tint2/xsettingsd/cua-spacesd/Xvnc 进程。没有截图、聊天内容、数据库读取、输入动作或自动修复。配置保存在服务器私有目录 `/root/woc-desktop-test/soak`；结果位于其 `overnight-20261029/` 子目录，服务日志为 `service.log`。

```sh
ssh root@192.168.31.101 'systemctl show woc-d1-soak-20261029 --property=ActiveState --property=SubState --property=Result'
ssh root@192.168.31.101 'python3 /root/woc-desktop-test/soak/report.py /root/woc-desktop-test/soak/overnight-20261029/samples.jsonl'
```

复查时同时检查采样跨度/缺口、容器 ID/StartedAt、资源变化，以及 Mac Master 的登记状态；再打开网页确认画面与交互。五分钟采样不能证明两个样本之间始终正常，也不能代替 GUI 验收。
