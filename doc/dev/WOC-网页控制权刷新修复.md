# 网页刷新后的控制权恢复

2026-10-30。问题：人工已取得控制权，未点击交回，刷新网页却再次提示申请；服务端旧人工锁仍存在。

## 根因及修复

浏览器 API 模块原来在每次加载时随机生成 `controlClientId`。服务端人工身份由登录用户 ID 加该标签页 ID 组成，因此刷新前后成为两个操作者。旧锁没有因为刷新自动释放，新页面得到 `mine: false`；不是服务器在查询时重新分配了锁，也不是正常 TTL 到期。

现在将标签页 ID 存入 sessionStorage，浏览器导航类型为 reload 时复用。新打开的页面仍生成独立身份，包括 window.open 可能复制 sessionStorage 的情况。后退/前进若恢复原文档则使用原内存身份；如果重建新文档，此版本不承诺恢复旧身份。存储被浏览器禁用时退回独立的内存身份，刷新需要重新申请。

锁的 epoch、是否持锁仍从服务端查询，不持久化授权状态，不在刷新时调用 take。已有锁有效则继续持有；过期、交回或已被别人接管时不能因保留身份而恢复控制。请求状态返回前显示“正在确认控制权”，暂时禁止申请，避免首次渲染误导用户。

代码：[浏览器 API](../../panel/web/src/api.ts)、[桌面页](../../panel/web/src/pages/Desktop.tsx)。

## 当前优先级与超时语义

- 人工网页主动申请允许接管 Agent，也能接管其他人工标签页；交接会等待旧的在途操作安全结束。
- Agent 不得抢占人工，人工有效持锁时 Agent 写操作被拒绝，读取仍允许。
- 人工受管锁 TTL 为 30 秒；当前可见页面持锁时每 5 秒心跳，交互也会触发节流心跳。不是“30 秒不碰鼠标就释放”。
- 交回立即释放；关闭、长时间隐藏页面或断网使心跳停止，约 30 秒后过期，不需要永久等待人工点击交回。
- Agent 的 120 秒无 GUI 写入超时与人工心跳 TTL 是两套已有策略，本次不改变它们。

## 验证

可持续运行的回归：

```sh
cd panel/server
node --import tsx --test src/control/browser-refresh.test.ts
npm run test:control
npx tsc --noEmit
cd ../web
npx tsc --noEmit
npm run build
```

测试加载真实 api.ts，在新的 JS 上下文中模拟刷新，保留 tab storage，请求交给真实 ControlLeases。旧版断言失败：`refresh incorrectly displays Apply while the previous page still owns the lock`。修复后通过，并确认 epoch 不变、仅一次 take、后续心跳成功、继承了 storage 的新标签页仍只读、过期锁不复活。全部 26 项控制测试、前后端 TypeScript 与生产构建通过。

真实 Chrome 在完整桌面实例 `dfde788ec9` 验证；不接管微信，不发送消息。旧版刷新后无法找到“交回控制”，复现原问题。修复版同一脚本通过：刷新后显示“交回控制”，epoch 未变，take 总计一次，window.open 的新标签页只读，最后正常释放。私有浏览器脚本与截图保留在 ignored `artifacts/control-refresh/`。

## 部署

新镜像 `local/woc-panel:control-refresh-v1`：
`sha256:6032eca0da7cdde4521c4e4ea2e94d3613edbef0417be257b6a0f9c76cd7ee71`。

[Web.Dockerfile](../../deploy/unified/Web.Dockerfile) 在已部署的微信 UI v2 后端基础上更新构建后的网页，保留旧哈希静态资源，供已经打开的页面使用。构建先运行 panel/web 的 npm ci 和 npm run build。

服务器 Fastify static 使用 wildcard:false，资源路径在启动时登记，不能只复制新文件完成热更新。曾尝试的热更新已撤回，之后确认三台机器无持锁任务，只重建唯一面板容器。现有微信、浏览器、完整桌面及独立 cua-worker-01 的容器 ID/StartedAt 未变化，微信 PID 仍为 80625。

统一部署的 .env 已固定新镜像。旧 .env、网页和容器状态保存在私有 `/root/woc-ui-private/control-refresh-before/`；回滚用备份镜像重建面板，不动实例数据卷。没有修改账号、客户端凭证、原 Cua 或 daemon。

升级前已打开的旧网页尚无保存的标签页身份，首次加载新版后可能需要再申请一次；之后同标签页在锁有效期内正常刷新即可恢复。PWA 浏览器需实际加载到更新后的资源。
