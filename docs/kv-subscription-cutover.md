# 订阅 KV LIST 额度修复：验收与受控切换

状态：**代码草稿，尚未部署、建表、迁移或切换**。

## 已证实的故障

`boll-alert-subscriptions` 每分钟运行一次。原来的每日订阅和条件预警分别在每次调用开始时扫描 `sub:`、`alert:`；空列表也会发起 LIST。基础负载为每天 `2 × 1,440 = 2,880` 次 LIST 请求，超过免费档每日 1,000 次的上限。GraphQL 请求计数可能包含失败请求，不等同于成功次数或计费数量。

2026-10-01 的只读诊断已验证：

- 流量来自 `boll_alert_subscriptions`，不是 SolMate 的聊天限流
- Worker 的 `SUBSCRIPTIONS` KV 与现有 `DB` D1 绑定均存在
- 四个已部署模块的规范化 SHA-256 与 lianghua `511d018e` 一致
- 15 个 Pages 项目均没有 KV 绑定
- [最终诊断运行](https://github.com/letuluvme-hub/solmate/actions/runs/36866599328) 成功，37 次只读 API 请求，未读取 KV 键/值或修改生产

## 此补丁改变什么

每日订阅、条件预警的配置和发送去重状态改为由现有 D1 存储。登录、会话、自选列表、板块缓存仍留在 KV。快照模块的订阅来源改读 D1，自选来源继续读 KV。

- 每分钟的两个订阅扫描不再调用 KV LIST
- 每日推送仍按用户选择的上海时间分钟筛选；D1 有分钟表达式索引
- 条件预警仍每分钟检查，cron 表达式不变
- 快照、板块刷新时机和内容保持原样；低频 `watchlist:` LIST 仍可能存在
- 配置更新只改配置；发信完成只改去重状态
- 取消订阅物理删除 D1 行；重新订阅生成新 generation。旧发送不能重建删除的行，也不能污染新订阅
- D1 不可用时不退回旧 KV 数据，不自动恢复全量扫描

## 必须提前同意的影响

1. 订阅记录移入现有 D1，订阅功能依赖 D1
2. 切换时需要短暂暂停订阅新增、编辑、取消和订阅邮件分发。页面、登录、自选、其他行情接口仍可用。暂停会影响落在该窗口内的推送，不能承诺无延迟
3. 已经交给邮件服务的邮件无法在取消订阅时召回
4. 若邮件服务是否接收无法确定，系统保留 `sending` 记录并暂停该订阅后续发送，等待核对；不能清空状态后盲目重跑
5. 不允许永久保留邮箱索引或取消订阅墓碑。临时导入表与旧 KV 订阅副本必须在切换前清理并验证

**本 PR 不授权以下生产动作。需另行确认窗口、迁移、旧副本清理和上线。**

## 三种运行模式

`SUBSCRIPTION_STORAGE_MODE`：

- 未设置或 `legacy`：保持 KV 运行，便于先发布兼容代码。此时额度问题尚未解决
- `handover`：订阅读取仍来自 KV，订阅更改和正常/强制分发返回维护状态；供冻结、导入和最终核对使用
- `d1`：只用 D1 订阅；要求 `subscription_storage_control.ready=1`。未就绪、数据库不可用、模式拼错均拒绝服务，不回落 KV

默认发布不会切换。部署脚本会保留已有模式绑定，无法确认已有绑定时拒绝覆盖。D1 订阅启用后禁止使用 `DISABLE_D1=1` 作为整体回滚。

## 离线验收

Node.js 24（内置 `node:sqlite`），不需要 npm 安装或网络：

```sh
node --test tests/subscription-store.test.mjs tests/subscription-scheduler.test.mjs tests/subscription-import-cli.test.mjs
node --check subscription-worker.js
node --check subscription-store.js
node --check snapshot-store.js
node --check deploy-subscription-worker.js
node --check scripts/subscription-import.mjs
```

关键检查包括：1,440 个分钟 tick 中订阅路径零 KV LIST；指定分钟/上海午夜；每日和预警去重；强制推送语义；每分钟预警；发送过程中更改、删除、重新订阅；不明发送结果不自动重试；完整分页；导入中断恢复；就绪门禁；D1 失败不读旧 KV。

## 迁移前检查

- 确认在线 Worker 仍绑定预期 `SUBSCRIPTIONS` 与现有 `DB`，代码对应已审核提交
- 确认现有 D1 表无命名冲突，显式应用 `migrations/0001-subscriptions.sql`。它只添加订阅相关表/索引/触发器，默认 `ready=0`；不创建数据库或自动启用功能
- 确认已部署所有新模块，但先保持 `legacy`
- 安排低风险窗口，检查当时是否有计划邮件或活跃预警。若不能接受暂停，停止此切换方案，不得用不可靠的双写代替
- 保留可恢复备份，验证其访问范围和保留期限；不要把订阅数据、SQL绑定参数、邮件正文或凭据放进日志、工单或 Git
- LIST 当日额度耗尽时，等待 UTC 重置或另行批准恢复方案。REST/CLI 不会绕过同一个 KV 额度

## 冻结与排空

将在线 Worker 显式切换为 `handover`，保留 `* * * * *` cron。确认所有旧版本请求、旧 cron 和管理发送请求已排空，所有订阅写入口均停止；不能只等一个任意固定秒数就视为完成。

等待并核对 KV 传播后的稳定状态。暂停期间不允许其他脚本直接更改 `sub:`/`alert:`。若无法确认这些条件，停止迁移。

## 有界导入工具

`scripts/subscription-import.mjs` 只读环境中的既有 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN`。不要把值复制到聊天或仓库。它读取在线 Worker 绑定进行验证；写入步骤要求在线模式确实是 `handover`。工具没有建库、建表、发信、修改 Worker 配置、清理旧数据或激活命令。

默认 `status` 只输出模式、就绪状态和聚合计数，不输出邮箱、游标、记录或密钥。

```sh
node scripts/subscription-import.mjs status
node scripts/subscription-import.mjs begin --import-id=cutover-YYYYMMDD --apply --handover-confirmed --dispatch-drained
node scripts/subscription-import.mjs scan-page --import-id=cutover-YYYYMMDD --apply --handover-confirmed --dispatch-drained
node scripts/subscription-import.mjs promote-page --import-id=cutover-YYYYMMDD --apply --handover-confirmed --dispatch-drained
node scripts/subscription-import.mjs verify --import-id=cutover-YYYYMMDD --apply --handover-confirmed --dispatch-drained
```

逐次运行 `scan-page`，直到两个前缀完整。每次最多 100 个键；数据库保存游标，空页带续页游标时必须继续。不要自己保存或输出游标。接口失败、权限不足、内容变化、格式异常时停止并查明原因。

逐次运行 `promote-page`，直到 `complete=true`。最后运行 `verify`，逐项核对配置、generation 和历史去重字段，并封存已验证状态。不要只比行数。标记确认旗标只代表操作员真的完成了对应检查，不替代那些检查。

## 清理与激活门禁

继续保持 `handover`。在再次确认无旧写入/发送者后：

1. 验证导入完全、配置与去重状态一致
2. 在单独批准的清理操作中，有界删除旧 `sub:`/`alert:` KV 副本，只允许删除已逐条匹配 D1 的记录。出现新增或不一致立即停止。不要动登录、会话、自选、板块或快照键
3. 等待并验证 KV 传播后这两个旧前缀为空。若无法验证，不得切换
4. 清理该次导入的暂存行，避免取消订阅后仍遗留个人数据。保留的导入状态只含非个人进度/聚合值；邮箱型进度游标也应清空
5. 仅在匹配的导入已完整验证、目标数量吻合且暂存为空时，显式设置就绪标记。数据库触发器会拒绝未完成/未验证导入
6. 显式切换在线模式为 `d1`，核对实际部署模式和已审核模块；不改 cron

此补丁不提供一步自动执行上述清理和激活的按钮，避免误把导入成功当作生产切换许可。

## 上线验收

先使用受控测试订阅，不给真实订阅者额外发信。验证新增、更改、取消、重新订阅与选定分钟；确认旧代发送完成不会重建已删除记录。

检查每分钟调用、D1错误、不明发送状态和 LIST 请求曲线。全天正常分钟调度的订阅 LIST 应为零；低频自选/快照扫描另计，不能把账户全量 LIST 强行要求为零。跨一个完整 UTC 日确认不再触及 KV LIST 日额度，同时观察 D1读取/写入、邮件与 Worker 子请求预算。

## 不明发送结果

`delivery_phase='sending'` 代表已经准备交给邮件服务，不能仅凭 lease 过期重发。稳定 Idempotency-Key 是 `subscription-<attempt_id>`；[Resend 幂等键](https://resend.com/docs/dashboard/emails/idempotency-keys) 有限期，不能作为无限期重试保证。

由有权限的操作员核对服务商结果后，才可：对已接受的同代邮件记录其准备好的去重状态；对确定未发送的同代尝试解除持有。操作必须同时匹配 generation、attempt_id、owner 和状态版本，只更新发送状态，不能插入订阅。若结果仍不明，继续保留并告警。不要批量清空 sending，也不要调用强制发送当作修复。

## 回滚

- 切换前且旧 KV 仍完整：可撤销 handover，返回兼容版 `legacy`，但原额度故障也会恢复
- 已清理旧 KV 或已启用 D1：只能回滚到 D1兼容代码，保留 DB 与模式绑定
- 禁止因 D1故障自动读旧 KV，禁止直接部署历史 KV-only Worker；这样会恢复取消的订阅或使用过期去重状态
- 若必须回到 KV，需另一个冻结/排空窗口、从当前 D1完整反向迁移配置和发送状态、清除旧残留并验证，再显式切换。不能使用迁移前快照覆盖用户迁移后的更改

参考：[D1 primary consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)、[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[KV list pagination](https://developers.cloudflare.com/kv/api/list-keys/)

## 剩余容量与预算

若账户使用 Workers Free，[D1 当前免费额度](https://developers.cloudflare.com/d1/platform/pricing/)是每日 500 万读取行、10 万写入行，UTC 00:00 重置。额度与其他 D1 工作共享；索引也可能增加读写计数，应以返回的 `meta.rows_read/rows_written` 或官方指标复核，不能把本地 SQLite 的语句数当成计费行数。

本次没有读取真实订阅数量，下面只是容量估算：

- N 条预警每分钟检查一次，基础订阅读取量约 `1,440 × N` 行/天，另有分页、就绪门禁、索引、发送状态与快照读取
- N=100：约14.4万基础读取行/天；N=1,000：约144万；N=3,000：约432万，已接近免费读取预算，应提前做容量评估。不能把理论约3,472条当作安全容量，因为尚未扣除其他读负载
- 每日订阅按所选分钟的表达式索引查询，不再每分钟全扫所有每日订阅
- 无新预警时不领取/释放租约，因此闲置预警扫描**零 D1 写入**；离线已用1,440个tick验证。不能在行情检查前领取租约，否则每条空闲订阅每天产生2,880次更新
- 正常实际邮件发送的状态更新约3次（claim、prepare、complete）；还要加配置更改/索引维护、取消、失败处理、导入与现有快照写入。只按状态更新计算的上限不等于服务容量
- 行情抓取、Worker CPU/子请求、邮件商日额度仍是独立约束。本补丁不改变预警频率，也不替换这些容量规划

上线前记录基线，上线后先核对一个完整 UTC 日。若预计读写预算不足，应先讨论按股票聚合检查、分批调度或套餐方案，不能静默放慢用户的预警。
