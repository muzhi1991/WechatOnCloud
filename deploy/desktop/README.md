# 完整桌面模式（D1）

应用模式与完整桌面模式并行；旧记录缺省 `mode=app`。完整桌面使用单独的镜像、容器、数据卷和 Cua 凭证，首版只创建空白桌面，不支持运行中互转或复用应用卷。

桌面基于已验收的 WOC/Cua P4 镜像，沿用同一 Openbox/Xvnc/D-Bus/AT-SPI 会话，增加固定版本的 tint2 和 PCManFM。桌面不依赖某个主应用存活；正常关闭应用不会重拉，最小化可从任务栏恢复。

## 使用

管理页 → 新建实例 → 完整桌面。首版完整桌面自动启用受管 Cua，部署需要同时开启 Cua 和控制服务。创建后点进入实例，再申请控制。

- 底部任务栏：浏览器、文件管理器、终端、打开的窗口、系统托盘和时钟。
- 网页「应用菜单」或桌面右键：打开上述应用，以及微信、Telegram、QQ；通讯应用首次选择时在可见终端运行原 WOC 安装器，安装完成后再次选择以启动。不是自动安装或自动登录。
- 「显示桌面」「切换窗口」和已有的特殊按键、文件传输、输入条可继续使用。
- 「全屏」进入浏览器全屏，Esc 退出；「捕获鼠标」限制鼠标到远端画面，Esc 释放。通过标准 Pointer Lock 请求和当前打包 KasmVNC 的光标事件处理，不启用游戏相对鼠标模式。浏览器不支持时提示原因。
- 快捷键：Super+Space 应用菜单，Super+E 文件管理器，Super+T 终端，Super+B 浏览器，Super+D 显示桌面，Alt+Tab 切换窗口。
- 完整桌面网页使用本地缩放；查看页大小不改变 X 会话分辨率。原应用模式保持原显示行为。
- 局域网 HTTP 下关闭依赖浏览器安全上下文的无感剪贴板同步，使用面板输入条/剪贴板入口。输入条沿用 Ctrl+V；xterm 等不使用 Ctrl+V 粘贴的应用，应先通过「剪贴板」放入文字，再在应用内按 Shift+Insert。

参考：[KasmVNC 客户端 Pointer Lock 与本地缩放](https://docs.kasmvnc.com/docs/developer/clientside/)。实际兼容性以本次打包版本验收为准。

## 与应用模式的隔离边界

| 机制 | 完整桌面处理 |
| --- | --- |
| Xvnc / KasmVNC、Openbox、D-Bus、AT-SPI、Cua | 保留，属于通用桌面基础设施 |
| 正确的字体/DPI、中文输入、剪贴板修复、文件传输 | 保留；桌面由独立 session 配置，不运行应用 autostart |
| WOC 控制租约、实例网络、凭证、备份/回滚 | 共用受管接口；每个实例的身份、卷、控制状态独立 |
| 主应用等待安装、常驻重拉、自动最大化、最小化恢复 | 不加载；用户正常关闭/最小化窗口 |
| deepin 伪装、品牌 hostname/MAC、删除容器标记 | 不启用；使用真实 Debian、普通 desktop hostname 和 Docker 网络身份 |
| Linux machine-id | 由桌面自己的 init 按卷生成并持久化，属于普通系统身份 |
| 应用内存阈值、VNC 连接失败自动重建 | 不继承；桌面默认不自动重建，保留 Docker 资源上限和显式维护操作 |
| 浏览器主应用启动参数 | 桌面独立启动器，不读取 WOC 的 chromium app-def；不强制最大化/固定缩放 |
| 微信/QQ/Telegram 安装与运行依赖 | 只在用户显式启动这些应用时调用独立的应用适配分支，桌面启动不依赖它们 |
| 输入条自动回车 | 桌面独立偏好，默认关闭；应用模式保持原默认 |

代码主要落在 `docker/desktop/`、后端 `desktop.ts`、前端 `DesktopControls.tsx`。原 WOC `docker/autostart`、身份脚本和应用安装脚本没有修改。派生桌面镜像构建时移除三个应用专用 init hook，复制独立 autostart，不再按字符串修改上游启动脚本。

当前仍复用**固定版本** WOC/Cua P4 镜像中已验收的系统包和通用传输修复，因此不是声称完全没有二进制依赖。应用镜像升级不会自动更新桌面镜像；升级桌面底座需单独构建、核对其依赖及验收。以后替换成独立通用底座时，保留这个 mode/镜像/启动 profile 接口即可，不需要重写面板。

## 构建与部署

在 llm-server 上验证基础 tag 对应的实际 image ID 后构建，禁止覆盖已有应用镜像 tag：

```sh
docker image inspect local/woc-cua:1.5.2-cua0.6.0-p4 --format '{{.Id}}'
# 当前已验收基础 ID：sha256:4a0b859c281fc097cc5e8d8c8b56f984e272963f41e8889eb78bbae4e0e1442a
sh deploy/desktop/build.sh
docker build --provenance=false --sbom=false --build-arg WOC_VERSION=dev-desktop-d1 \
  -t local/woc-panel:desktop-d1 ./panel
```

`compose.yaml` 是隔离测试部署：面板 36084，Cua 网关 13370–13389，独立网络/面板数据卷/秘密目录。不会接管 36083 的现有面板和微信。

将构建结果的 image ID 写入部署私有 `.env` 的 `WOC_DESKTOP_IMAGE`；API 只接受 image ID 或 digest，不能使用可变 tag。原应用镜像仍由 `WOC_CUA_IMAGE` / `WOC_WECHAT_IMAGE` 选择。创建、显式升级和可升级判断按 mode 选择镜像；重启沿用原 image ID；重建和镜像回滚在移除容器前校验模式 label，禁止交叉使用两类镜像。

`secrets/` 按原 Cua 部署约定放置管理员密码、独立同步 token、独立 Agent token；目录 0700，文件 0600，不能提交。`WOC_CUA_HOST_SECRETS_DIR` 必须是宿主机实际路径。

```sh
cd deploy/desktop
docker compose up -d --pull never
```

Master 登记仍使用 `integrations/cua-master-sync`，为新面板配置独立 deploymentId、`woc-desktop` namespace、私有 state 和端口范围。这个登记供受管 Agent 使用；原生 Cua App 视频直连仍是单独功能，D1 不自动发布原始管理端口。

## 数据与边界

新增配置均在各实例自己的 `/config` 数据卷内，使用固定数量的文件，不新增无界日志或后台消息采集。`woc.tint2rc`、`woc-menu.xml`、Openbox `rc.xml` 和六个 WOC launcher 在启动时幂等生成；修改这些生成文件不会跨重启保留。其他用户文件、浏览器 profile 和应用数据沿用原持久卷及备份机制，文件管理器查看 `/config`。

桌面浏览器磁盘缓存配置为 256 MiB，媒体缓存 64 MiB。新增桌面进程 stdout/stderr 进入有容量上限的 Docker 日志；可选通讯应用的安装器和临时空间沿用其适配器策略。用户主动创建的文件不会自动删除；磁盘和卷容量仍需按原 WOC 运维管理。

## 验证与回滚

```sh
cd panel/server
npm run test:desktop
npm run test:cua
npm run test:control
npm run test:lifecycle
npx tsc --noEmit
cd ../web
npx tsc --noEmit
npm run build
```

真实测试必须覆盖新桌面与新应用实例并行、浏览器/终端/文件管理器多窗口、最小化恢复、拖动、中文输入、全屏/鼠标捕获、两页查看、人工/Agent交接，以及重启后的文件和配置保留。

当前实际通过项与待验项见 [D1 验收记录](../../doc/dev/Cua-D1验收记录.md)。桌面状态检测的是 Openbox、tint2、xsettingsd 进程，不把“镜像里存在启动脚本”当作桌面已就绪；这仍不能代替画面和交互验收。

本阶段为独立自用试点，未发布正式 release。回滚时停止新增桌面测试实例和独立面板即可；保留数据卷和私有配置供恢复，不操作原面板或现有微信。已有桌面实例以后回滚只允许选择经过验收、带 `io.woc.desktop=1` 的桌面镜像，不能换回应用镜像冒充恢复。
