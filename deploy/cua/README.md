# WOC + Cua 单实例 canary（P1）

此部署独立于现有 `cua-worker-01`。尚不包含 WOC 面板、自动登记协调器和控制权租约，限一个操作者串行测试。`36081` 是 KasmVNC 原生网页，不是 WOC 多实例管理面板。

## 固定版本

| 组件 | 固定值 |
|---|---|
| 源码基线 | WOC `8b804e109aa5fcdc63799e028a4397f88c9ca694` |
| 已发布实例基础 | `1.5.2`，release commit `237b5c7361dcf96ded9c9ee3182e1c0b145a1974` |
| amd64 manifest | `sha256:731891df34ad53ea7000415d6e2b3fcb990dc3aadc63a59a15b06e521b165cf8` |
| Cua Spacesd | 官方 `0.6.0` Linux x86_64 二进制 |
| 二进制 SHA256 | `73f4ab392d7832561b454ce137114f22242753f43a9e95166259bbf72e514379` |
| 派生镜像本地标签 | `local/woc-cua:1.5.2-cua0.6.0-p1` |

当前 main 比 release 多的实例 Dockerfile 变更是 KasmVNC 图片剪贴板修复；派生镜像显式带入。不是从滚动 `latest` 构建，不升级 Chromium。

## 构建与启动

仅 Linux amd64；在独立仓库目录运行：

```sh
bash scripts/cua/build.sh
bash scripts/cua/prepare.sh
# 检查 deploy/cua/.env 中 BIND_IP，并确认 13311、36081 未被占用。
docker compose -f deploy/cua/compose.yaml --env-file deploy/cua/.env up -d
bash scripts/cua/smoke.sh
```

llm-server 部署目录为 `/root/woc-cua-canary`。容器固定为 `woc-cua-canary-01`，数据卷为 `woc-cua-canary-01-config`，Compose 项目为 `woc-cua-canary`。只绑定指定的内网地址；Cua 和网页使用不同随机凭证。不给实例挂 Docker socket。CPU 2 核、内存及内存+swap 上限均 4 GiB，shm 1 GiB。

网页：`http://192.168.31.101:36081`，用户名 `canary`；密码在服务器 `deploy/cua/secrets/vnc-password`。Cua：`http://192.168.31.101:13311`，token 在 `deploy/cua/secrets/cua-token`。这些文件为 0600，目录 0700，不纳入 Git；不要打印到共享日志。HTTP 入口仅用于可信内网，跨网络使用现有 SSH 隧道。

Master 通过官方 `cua spaces add URL --name woc-cua-canary-01` 登记，凭证以 `CUA_ENV_TOKEN` 环境传入。这是当前 Master 的本地登记，不会自动创建容器，也不代表其他 Master 已同步。

## 同桌面实现

保留上游 `/init`、s6、Xvnc 和 Openbox。在 Cua 模式中用 `dbus-run-session` 包装原始 startwm，让桌面应用和 Cua 共用一条会话总线；安装基础镜像遗漏的 `at-spi2-core=2.46.0-5`。Openbox autostart 将限定的一组会话变量原子写到 `/run/woc-cua/session.env`。新增 s6 服务先降权为 `abc`，再读取会话并等待 X 就绪，最后启动 spacesd。没有第二个 X server。Cua 异常只重启自身服务，5 秒退避。

`WOC_RESTORE_MINIMIZED` 默认 `1`，兼容原来的窗口看守；canary 设为 `0`，允许最小化和切换多个应用。普通上游镜像未包含 Cua 脚本时不会执行新增入口。`WOC_CUA_ENABLED=0` 关闭 Cua 服务，人工桌面不受影响。QUIC、guest power 和闲置鼠标探测在此原型中关闭。

## 数据边界

- `/config`：独立持久卷，包含微信目录、Cua 状态、工作文件和 Downloads；没有复制现有微信数据。
- `/run/woc-cua`：临时会话变量及只读给 abc 的 token 副本；重建不保留。原始 token 独立挂载，普通 `/config` 备份不含它。
- Docker stdout/stderr：10 MiB × 3 轮转；P1 禁用 Cua 持久 access.log，正式任务审计/缓存清理/卷配额在 P4 完成。
- `/config/workspace` 和 Downloads 是用户成果，不自动清理。P1 由部署者监测容量，不开放无人值守持续任务。

## 重建、回滚与清理

重建仅执行这个 Compose 项目的 `up -d --force-recreate desktop`，不执行宿主级 prune、不碰已有 Cua 配置。重建前记录镜像 ID；更换镜像需显式构建并核验。

停止原型：`docker compose -f deploy/cua/compose.yaml --env-file deploy/cua/.env stop desktop`。删除容器保留数据使用同一项目的 `down`，不带 `-v`。本地撤销登记用 `cua spaces rm woc-cua-canary-01`，不是删除 sandbox。数据卷和密钥删除必须另外明确决定。

## 验收范围

`smoke.sh` 验证进程、同一 X server、依赖、token 权限和健康。还须实测 Cua 截图/窗口、中文输入/剪贴板、浏览器与终端切换、桌面尺寸变化、KasmVNC 网页出画面和容器重建持久性。正式发布前仍需上游发布门禁与过夜试运行。

P2 才接入 WOC 面板的动态创建和自动注册；P3 实现人工/Agent 控制权。因此当前不要同时使用网页和 Agent 操作，也不要启用真实微信自动回复。
