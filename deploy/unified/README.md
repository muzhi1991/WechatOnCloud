# 统一控制台：原面板增加完整桌面

2026-10-29，按用户要求停止独立 D1 测试部署，在原 36083 面板新建桌面验证。不迁移 D1 实例、凭证或登记，不引入跨部署接管逻辑。

## 当前入口与部署

统一入口：http://192.168.31.101:36083 。保留原管理员和面板数据卷，创建弹窗提供应用模式与完整桌面模式。

| 实例 | ID | Cua 网关 |
| --- | --- | --- |
| 原浏览器 P3控制验收 | `53c41906da` | 13340 |
| 原微信 P5微信测试 | `77bafd5161` | 13341 |
| 新建完整桌面 | `dfde788ec9` | 13342 |

面板为原 `woc-cua-panel-p3`，只更新面板容器。服务器声明配置位于 `/root/woc-cua-control/deploy/unified/compose.yaml`，使用同名 Compose project，避免启动第二个面板。`.env` 指定：

```text
WOC_UNIFIED_PANEL_IMAGE=sha256:0b515ecc33a94903be3581753e956ee28275fd4fa67b0a9319345e8e62377d5e
```

这是 D1 已验收的同一个面板镜像；桌面镜像仍为 `sha256:ce67703372b350bd63a9642a52e78a3daff2b34e752f588ec29656557c7e4f05`。应用镜像不变。后续部署从此目录运行 `docker compose up -d --pull never`，不再使用旧 lifecycle compose 覆盖配置。没有正式 release 或上游推送。

Master 仍使用 `~/.local/share/woc-cua-p3/` 和 `local.woc-cua-p3.sync`；三个实例在同一 deployment/namespace 下。新增登记遇到本机 Cua daemon 的连接问题，改用先前 D1 已验证的官方 embedded CLI wrapper，副本放在 P3 自己的私有目录，避免依赖退休目录。原 P5 原生直连不变。

## 验收

- 实际网页登录原管理员，管理页新建「完整桌面」，创建完成后全部三个实例 running、Cua ready、Master registered。
- 同一主页显示原微信、原浏览器和新桌面；浏览器只读查看确认原微信仍登录，没有输入或发送消息。
- 新桌面通过网页申请控制，从任务栏打开文件管理器和终端，确认多窗口显示；交回控制恢复只读。
- 受管 Agent 通过 13342 申请租约、调用窗口枚举并释放成功。桌面组件/全屏/鼠标捕获沿用此前已验收的相同镜像与代码，详见 [D1 验收](../../doc/dev/Cua-D1验收记录.md)。
- 原微信、原浏览器及其余五个受保护容器的 ID/StartedAt 前后完全一致；只有面板服务按授权重建。没有重新登录、迁移数据卷或重启微信进程。
- Compose 配置校验通过。本次只有部署与文档变更，未引入新的运行时代码。

证据在 ignored `artifacts/unified-console.png`、`unified-desktop.png`、`unified-protected-before.txt`、`unified-protected-after.txt`。

## 退休 D1 测试环境

已停止 `woc-desktop-panel-d1` 和它的三个实例 `5d8379ca7b`、`0d8d2f1be2`、`c86fb1ebe5`。36084 不再提供服务。容器和数据卷保留，没有删除；不应重新运行该目录的 compose。D1 Mac 同步 LaunchAgent 已卸载并将 plist 移至其私有状态目录，三个旧 Master 登记仅执行 `spaces rm`，没有删除 sandbox/数据。

历史 P1/P2 环境不属于本次 36083/36084 两套的切换，保持原状。本次日常使用统一到 36083，不宣称全服务器所有历史实验环境均已清理。

## 稳定性观察

切换前结束旧采样并保留结果：P5 共 208 个样本、17.255 小时，无探测错误/异常/采样缺口；独立 D1 共 7 个样本、0.500 小时，无异常，但没有达到过夜时长。不能把主动停止测试部署解释为故障，也不能将它声称为过夜验收通过。

统一环境分别启动 36 小时只读采样，间隔 300 秒，服务 37 小时硬上限：

- `woc-unified-desktop-soak-20261029.service`
- `woc-unified-wechat-soak-20261029.service`

配置、程序与输出位于服务器 `/root/woc-cua-control/soak-unified/`（私有目录）。两项预检查均通过；采集容器/资源、登记、Health RPC、进程和控制状态，不读取消息/数据库、不截图、不输入、不自动修复。报告命令：

```sh
ssh root@192.168.31.101 'python3 /root/woc-cua-control/soak-unified/report.py /root/woc-cua-control/soak-unified/desktop-20261029/samples.jsonl'
ssh root@192.168.31.101 'python3 /root/woc-cua-control/soak-unified/report.py /root/woc-cua-control/soak-unified/wechat-20261029/samples.jsonl'
```

统一入口和桌面功能已交付，新的过夜结果仍待实际时间与次日 GUI 复查。

## 备份与回滚边界

更新前停面板后备份到服务器私有目录 `/root/woc-cua-control/unified-backup-20261029/`，含面板数据（包括已有备份）、秘密文件与旧面板 image ID。它不包含微信消息卷的额外抓取。本次只有这一份约 567 MiB 以内的管理配置/备份副本，没有新增周期备份任务。

回滚先停止统一面板和新桌面，保存更新后的面板状态，再恢复此前的面板数据、旧镜像和 lifecycle compose；旧微信/浏览器实例不重建、不回滚其数据卷。保留新桌面卷和登记状态，避免下一次创建误复用已分配端口。回滚属于管理状态恢复，不应同时重新启动 D1 面板。稳定验收后再按需清理私有快照与退休卷。
