# 原生 Cua 兼容与 WOC 写锁验收

日期：2026-10-29。按用户批准的 v3 方案，先实现截图/点击与锁，再由真实客户端 Agent 验证两个 skill 的组合，随后扩展其余 Cua 操作并做端到端验收。消息读取、监听、自动回复、数据库和网页 AI 未实施。

## 实际部署

- 统一控制台仍为 `http://192.168.31.101:36083`，面板 `woc-cua-panel-p3`。
- 当前镜像：`sha256:f989a4fdff00379ac16be778e0a3d5b8d33ecd3cba05666fc8926c3b2dd37176`，版本 `dev-lock-v3`。
- 原三台登记的名称/地址不变：`woc-p3-53c41906da`、`woc-p3-77bafd5161`、`woc-p3-dfde788ec9`，端口 13340/13341/13342。
- 原 Master 同步任务改用稳定 `mac-agent` 凭证。凭证与 WOC MCP 映射同一个服务端身份；服务器仅存 SHA-256。该身份明确授权本面板当前及未来受管实例。
- 本机安装 `woc-control` skill，并配置 `woc` 和原生 `cua_native` MCP（原命令 `cua --embedded mcp`）。原 cua-spaces skill、Cua 源码/二进制和 spacesd 未修改。
- 所有真实 GUI 写测试只针对完整桌面 `dfde788ec9`；没有操作微信消息。微信、浏览器、完整桌面和原 `cua-worker-01` 的容器 ID/StartedAt 前后一致，仅面板容器升级。

## 客户端 Agent 真实调用

三轮均为 Mac 上实际运行的客户端 Codex Agent，读取 skill 文件，通过配置的原生 Cua MCP 和 WOC MCP 发出工具调用。不是假设的工具轨迹或 HTTP 模拟。记录包含实际 MCP 调用、结果和 Agent 报告，位于 ignored `artifacts/lock-v3/`。

1. **最小链路**：无锁观察成功；点击被拒且 Agent 看见错误；WOC 上锁；原 Cua 重新观察并点击空白桌面；释放；再次点击被拒；观察仍可用，最终 free。初版首次访问返回的 `WOC_CONTROL_BLOCKED` 已修正为 `WOC_LOCK_REQUIRED`。
2. **扩展操作**：新建测试终端，激活窗口、修改/恢复窗口框、点击、双击、右键、按键、快捷键、滚动、拖动、文本输入、`run_steps` 和 `run_script`。截图确认 echo 输出与拖动选择文本。隔离 Chromium 在本地 `data:` 页面完成输入与按钮点击。只清理本轮启动的终端/浏览器进程，保留原窗口。
3. **原登记最终复验**：使用原 `woc-p3-dfde788ec9` / `192.168.31.101:13342`，不是临时隧道别名。完整验证无锁拒绝、上锁后点击、剪贴板写入/精确读回/清空、释放后拒绝与无锁观察。最终 `free / mine:false / inflight:0`。

Agent 实际看到的错误示例：

```text
error: rpc failed: WOC_LOCK_REQUIRED: 本次操作未执行。
GUI write requires this client to hold the lock。
请通过 WOC skill 调用 woc_lock_acquire(machine_id="dfde788ec9")；
成功后重新观察再操作，用完 woc_lock_release。120 秒无 GUI 写自动释放。
(FailedPrecondition)
```

最终回合从首次拒绝到释放后拒绝，Cua 连接凭证始终不变，没有额外传 lock_id/epoch 给原 Cua。只有 WOC release 使用本轮 lock_id。

## 锁与协议验证

| 验证 | 实际结果 |
| --- | --- |
| 63 个 Driver 工具 | 部署版本完整枚举有明确策略；保留契约快照防止新增工具漏分类 |
| 37 个 GUI 写入口 | 使用原 Cua MCP 实际逐项发出无锁请求，全部在转发前被拒；包含 batch、脚本、回放和浏览器入口 |
| 两个认证客户端 | A 持锁时 B 获取失败；B 持锁时 A 仍能观察，写入被拒；测试 B 凭证验收后已撤销 |
| 实际空闲超时 | 持续观察/状态查询仍在约 120 秒后失效；后续点击返回 WOC_LOCK_EXPIRED；同一稳定凭证重新获取成功 |
| 旧释放请求 | A 重新上锁后，旧 lock_id 无法释放新锁 |
| 人工接管 | 调用网页使用的真实 take/release 接口；人工接管后原 Agent 写被拒，旧 Agent release 不能释放人工控制，观察正常 |
| 原生命令/文件/Agent | `space_bash`、`space_write`、文件读回（包含中文）、`agent_list` 成功；持锁时这些调用不续期、不释放 |
| gRPC-Web/MCP | 原生错误可见；`/mcp` initialize、工具发现可用；MCP 写错误带 isError 和提示 |
| 原生媒体 | 请求可交互/双向几何仍被降为 view_only/observe_only；实际接收到视频帧；窗口流 InteractiveInput 与 Action 均返回 delivered:false、view_only |
| viewer ticket | 只读请求可用，写请求在网关返回 WOC_VIEW_ONLY |
| 在途/实例变化 | 单元测试覆盖断连仍保留 fence、超时不提前交接、故障隔离，以及异步运行实例复核后旧 epoch 不得继续派发 |

媒体 hello 的全局 capability 列表仍包含 input.interactive，不能据此判断授权。验收依据是具体 session 的 view_only 及实际输入拒绝结果。原生 App 独立直连仍按用户要求不参与锁。

## 验收范围与原生限制

“63 个工具接入”表示策略、转发与错误兼容；不等于逐项验证 Cua 在所有应用上的业务效果。所有 GUI 写入口做了真实无锁拒绝；主要日常操作做了有锁的真实客户端 Agent 验证。

- XTerm 尺寸修改时 Cua 原生几何校验返回 unverifiable；独立窗口读取确认最终恢复，但不将原生校验记为成功。
- 部分双击/右键/滚动报告已派发，未观察到可证明的效果；与实际截图确认的点击、输入、拖动分别记录。
- 首次空剪贴板读报 X11 Atom 错误；最终轮在测试桌面显式写入后精确读回成功，清空并读回空字符串成功。没有修改原 Cua 的剪贴板实现。
- Chromium 背景热键由原生 Driver 拒绝；Agent 使用其支持的前台方式成功。脚本曾因自设调用预算过小失败，后续有界脚本成功；均按原生工具结果呈现。
- 未启动真实远端模型任务来验证 agent_start/message/stop 的模型执行效果；这组接口保留原生进程逻辑与不参与锁的约定。
- 原生 App 直连、进程/命令间接操作桌面和同一凭证内多任务隔离仍是已约定边界，不能宣称所有来源全局单写。

## 自动检查与收尾

- TypeScript 类型检查通过。
- 服务端控制/Cua/生命周期/桌面测试共 **36 项通过**；Master 同步测试 **6 项通过**。
- WOC skill 结构校验通过，`git diff --check` 通过。
- 临时 `14362` 隧道与登记已清理，测试文件已删除，原三个登记保留；本机长期身份只保留 mac-agent。
- 本轮未重新开始或声称完成过夜稳定性验收；原有只读采样的结果需另行检查，并识别计划内面板升级窗口。

接入说明：[WOC MCP](../../integrations/woc-mcp/README.md)。下一步仅讨论消息读取、监控和日常操作的具体接口；本轮没有预先实现这些业务。
