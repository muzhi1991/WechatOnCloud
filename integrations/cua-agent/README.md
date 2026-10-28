# 受管 Cua Agent 入口（P3）

这个 CLI 给一次 Agent 任务申请桌面控制权，再通过**官方 Cua CLI**执行 GUI RPC。它连接 P3 面板的控制网关；Master 自动登记的凭证只能观察，不能直接打字。

## 配置与使用

配置、服务凭证和租约目录保存在仓库外，目录权限 0700、文件 0600。每个并行任务使用不同的 `leaseDir`；不要让两个任务共享一份身份/租约文件。

```json
{
  "panelUrl": "http://192.168.31.101:36083",
  "agentTokenFile": "/private/path/cua-agent-token",
  "leaseDir": "/private/path/task-1/leases",
  "label": "我的 Agent",
  "cuaBinary": "/absolute/path/to/cua",
  "curlBinary": "/usr/bin/curl"
}
```

`agentTokenFile` 对应面板的 `cua-agent-token`，与协调器的 `cua-sync-token` 分开。此服务凭证由可信 Master 保管，可以申请该面板所有受管实例。不是多租户任务鉴权系统。`curlBinary` 可省略；Mac launchd 环境已实测用系统 curl 避免 Node fetch 的局域网访问问题。

```sh
node integrations/cua-agent/agent.mjs CONFIG acquire INSTANCE
node integrations/cua-agent/agent.mjs CONFIG call INSTANCE WindowsService/ListWindows '{}'
node integrations/cua-agent/agent.mjs CONFIG call INSTANCE ComputerService/Keyboard '{"type":{"text":"测试文字"}}'
node integrations/cua-agent/agent.mjs CONFIG status INSTANCE
node integrations/cua-agent/agent.mjs CONFIG release INSTANCE
```

人工持有时 acquire 失败；Agent 不能抢占。取得控制后应先截图或读取窗口，再根据最新画面操作。`call` 先续租，执行期间每 5 秒续租。两次调用相隔超过 30 秒需要重新申请；长时间推理可以主动 `renew`，或者交回控制。每次调用只执行一次，不自动重试输入。

人工随时可以从 WOC 页面接管；旧租约会失效。如果动作执行中发生接管，面板先等待已发出的动作结束。请求结果不确定时锁定输入，管理员显式恢复。发送类动作失败后必须核对画面和实际结果，不能把失败当作“未发送”而重复执行。

## 实际支持范围

- 已验证官方 `cua` 0.7.0 客户端和 `cua-spacesd` 0.6.0，通过 HTTP/1 gRPC-Web 通信。
- 截图、窗口列表、辅助功能树、剪贴板读取等观察操作可用 Master 登记凭证访问。
- 键鼠、剪贴板写入、窗口操作和应用启动需要短期租约。白名单见 `panel/server/src/control/protocol.ts`。
- 原始 `/mcp`、进程/Shell、隧道、文件写入、脚本/批处理重放、viewer ticket 和连续流接口未开放。当前提供这个 CLI 适配器，未注册新的 MCP 工具。
- 网关提供协作互斥，不隔离不可信 OS 用户。通过获准的桌面操作启动终端或后台进程，仍有可能在租约结束后继续运行；任务必须遵守交接，不另起持久输入自动化。独立后台任务使用原通用 Cua worker。
- Token 只在私有文件、请求头和 Cua 子进程环境中流转，不作为命令行参数或正常输出。旧租约文件可能仍存在，但服务端不再接受。
