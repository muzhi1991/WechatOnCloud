# WOC → Cua Master 协调器（P2）

WOC 创建、启动、重建和删除容器；本程序只将已就绪的实例登记到运行它的 Master 的 Cua 注册表。它不调用 Docker，也不会切换 Agent 当前选中的桌面。

## 配置与启动

需要 Node.js 22、已安装并可用的 Cua CLI（本轮验证 0.7.0），以及从该 Master 到面板和各实例 Cua 端口的连接。先配置面板，见 [部署说明](../../deploy/cua-panel/README.md)。

在 Master 的私有目录创建配置，目录权限 0700，配置和服务 token 文件权限 0600。通过 SSH 等已有可信通道复制服务 token；不要把 token 写进仓库、命令参数或日志。

```json
{
  "panelUrl": "http://192.168.31.101:36082",
  "serviceTokenFile": "/absolute/private/service-token",
  "stateFile": "/absolute/private/state.json",
  "cuaBinary": "/absolute/path/to/cua",
  "deploymentId": "从受认证 snapshot 接口读取的 deploymentId",
  "namespace": "woc-p2",
  "allowedHost": "192.168.31.101",
  "firstPort": 13320,
  "lastPort": 13339,
  "intervalSec": 10,
  "curlBinary": "/usr/bin/curl"
}
```

`deploymentId` 必须固定为这次部署的身份，不能每次连接时自动信任返回值。`curlBinary` 可省略，默认使用 Node fetch。本轮 Mac 的 launchd 上 Node fetch 返回 EHOSTUNREACH，而系统 curl 和 Cua CLI 可连接，因此明确选用系统 curl；Authorization 和 POST 内容经 stdin 传递，不进入进程参数。两种传输都不跟随重定向。

```sh
node integrations/cua-master-sync/sync.mjs /absolute/private/config.json --once
node integrations/cua-master-sync/sync.mjs /absolute/private/config.json
```

长期运行使用进程管理器，确保继承正确用户的 HOME，以操作同一个 Cua 注册表。Mac 可参考 [launchd 模板](launchd.plist.example)，替换绝对路径后放入 `~/Library/LaunchAgents/`，再执行 `launchctl bootstrap gui/$(id -u) <plist绝对路径>`。日志输出丢弃，最后健康状态持续覆盖到 `state.json.status`，不会无限增长。SIGTERM 会在当前请求和轮询结束后退出；KeepAlive 自动拉起后全量对账。

当前实测部署：配置在 `~/.local/share/woc-cua-p2/config.json`，LaunchAgent 为 `local.woc-cua-p2.sync`。

## 接口与恢复语义

- `GET /api/integrations/cua/snapshot`：独立 Bearer 服务身份；管理员 Cookie 不具备该权限。只给 `ready` 实例返回 token，普通实例列表不返回凭证。
- `POST /api/integrations/cua/ack`：相同服务身份，携带 deploymentId、id、generation、registered/error。过期 generation 返回 409。
- 固定命名空间、宿主、端口范围、实例 ID 和 deploymentId。拒绝身份不符、越界端点、旧 revision/generation、其他管理者占用的登记。
- 先把 pending 所有权写入本地 ledger，再调用 `cua spaces add`；CLI 成功后崩溃也可以重试恢复。ledger 只保存凭证 SHA-256，不存明文 token。CLI 自身按其原生机制保存连接凭证。
- offline、starting、orphaned 和快照缺失都不代表删除。只有明确 tombstone 才调用 `cua spaces rm`，且只忘记本协调器拥有的登记，不调用 sandbox delete。
- 每轮确认后刷新 ACK；面板重启丢失内存 ACK 后会自动补回。停止协调器不会撤销已登记的凭证，也不会关闭容器。
- 不要随意删除 ledger。没有所有权记录但端点已登记时会拒绝接管；需核对后恢复 ledger，或仅删除确定属于此部署的旧登记，再重建登记。
- 当前是单 Master、单进程协调器；PID 锁防止重复运行。面板和协调器状态都要持久化。端口暂不回收，避免删除/重建期间旧连接串到新账号。

CLI 的显示名称与 `cua do` sandbox 别名不同。0.7.0 实测使用注册表 ID 即可直接操作：

```sh
cua spaces ls --json
cua do switch direct:192.168.31.101:13320
cua do screenshot
```

无需在协调器里调用 `do switch`，避免自动登记抢走用户或另一任务当前的操作目标。P3 控制权交接尚未实现，P2 仅供单操作者串行验收。

## 验证

```sh
node --test integrations/cua-master-sync/*.test.mjs
```

覆盖两实例隔离、幂等、旧快照、重建、显式删除、局部失败重试、CLI 副作用后的崩溃恢复、身份/范围/所有权冲突。真实 Docker、面板和 Master 验收见 [P2 记录](../../doc/dev/Cua-P2验收记录.md)。
