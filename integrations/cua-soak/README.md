# 有时限的 P5 过夜观察

`soak.py` 是独立的只读运维采样器，不是微信消息监听器。它不抓屏、不读聊天树/数据库、不申请租约、不输入键鼠、不自动修复/重启任何实例。每 5 分钟读取指定容器的状态/资源/进程名称、受认证的注册快照、观察凭证的 Cua Health RPC、控制状态及宿主 uptime/可用磁盘。

凭证只从配置指定的私有文件读入内存，不写入 JSONL/异常日志。采样只保留明确挑选的字段；不保存容器环境变量或命令行。首次现场检查发现 docker top 需要 PID 列、status 需要 UUID clientId，已修正并复测。

## 当前运行

- 主机：llm-server `192.168.31.101`。
- systemd transient unit：`woc-p5-soak-20261028.service`。
- 脚本/私有配置：`/root/woc-cua-p5-soak/`。
- 正式结果：`/root/woc-cua-p5-soak/overnight-20261028/`，目录 0700，文件 0600。
- 目标：`woc-cua-panel-p3` 与独立微信 `woc-wx-77bafd5161`；不改原有 Cua worker。
- 运行 36 小时自动结束，systemd 37 小时硬上限；采样间隔 300 秒，最多约 433 条记录，通常少于数 MB。
- `results-20261028/` 是上线前试探日志，其中前一次采样有已修复的采样器错误，不能混作正式过夜异常。

Mac 协调器没有新增常驻任务。其状态基线见本地忽略目录 `artifacts/p5-soak-master-baseline.json`；第二天应读取最新 `~/.local/share/woc-cua-p3/state.json.status` 并核对注册表。宿主采样并不证明 Mac 一夜在线。

## 第二天检查

```sh
ssh root@192.168.31.101 'systemctl show woc-p5-soak-20261028 --property=ActiveState --property=SubState --property=Result'
ssh root@192.168.31.101 'python3 /root/woc-cua-p5-soak/report.py /root/woc-cua-p5-soak/overnight-20261028/samples.jsonl'
```

报告给出覆盖时长、探测失败、控制状态、缺口、容器身份变化、CPU/内存百分比/PID 范围。还需：

1. 将最后样本时间与当前时间比较，检查 run.json / finished.json、日志与宿主 uptime。采样器死亡或宿主重启可能表现为样本中断，不能只看“已有样本全绿”。此临时服务不跨宿主重启自动恢复，避免掩盖故障。
2. 核对容器 ID、StartedAt、RestartCount 和 generation 与基线；检查 OOM、资源增长和异常锁。
3. 检查 Mac 自动注册协调器最新状态及原有环境保护快照。
4. 重新通过 Cua 观察微信界面，确认没有登出/二维码/异常弹窗。需要输入时先取得控制权；任何发送仍遵守具体任务授权。

这些是采样点的健康证据，不能证明两次采样之间从未发生短暂故障；进程、Health RPC 成功也不能证明微信账号仍登录或消息都能收取。

如需提前结束，仅停止采样服务：

```sh
ssh root@192.168.31.101 'systemctl stop woc-p5-soak-20261028'
```

这不停止微信或面板。日志不自动清理，后续按保留策略处理。

## 复用

配置字段见 `soak.py`：显式限定 panelUrl、endpoint、deploymentId、instance、desktopContainer、containers、两条 token 文件路径、独立 outputDir、durationHours、intervalSeconds。先用**不同 outputDir** 的配置 `--once`，再启动正式采样，避免覆盖 run.json 基线。

完整桌面可另设 `requiredProcesses: ["openbox", "tint2", "xsettingsd", "cua-spacesd", "Xvnc"]`。缺省仍检查原 P5 微信进程，旧记录报告保持兼容。D1 只将更新后的采样器部署到自己的目录，不替换现有 P5 运行文件。

```sh
python3 -m unittest discover -s integrations/cua-soak -p 'test_*.py'
```

测试覆盖中断间隙、容器重启和探测失败的报告识别。部署前还必须在指定新测试实例验证一次真实只读采样。
