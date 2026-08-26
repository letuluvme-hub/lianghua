# 实施计划：预警邮件 AI 解读模块（ai-interpreter）

> 目标：在现有布林带预警邮件中附加一段由 Claude 生成的自然语言解读。
> **最高原则：新增一个独立模块，任何情况下不得影响现有功能** —— AI 不可用时，系统行为与接入前完全一致。

## 0. 背景与现状

- `subscription-worker.js` 是一个**零依赖 ES module** 的 Cloudflare Worker，由 `deploy-subscription-worker.js`
  通过 Cloudflare API multipart 上传部署（`main_module`），**没有 package.json、没有构建步骤**。
  因此**不能引入 npm 依赖**（包括 Anthropic 官方 SDK），调用 Claude 只能用 Worker 原生 `fetch` 直连
  Anthropic REST API（`POST https://api.anthropic.com/v1/messages`）。
- 预警链路：cron 每分钟触发 `sendDueAlerts(env, force)` → 遍历 KV 中 `alert:` 前缀的订阅 →
  `fetchStockSnapshot` 拉行情 → `evaluateAlert` 判定触发 → 有新触发时 `sendAlertEmail` →
  `renderAlertEmail` 生成 HTML 表格 → `sendResendEmail` 经 Resend 发信。
- 单条 alert 对象字段：`{ code, name, date, close, middle, standardDeviation, bands, multiplier,
  condition, side, boundary, distance, sigmaOffset, alertKey }`（外加本次新增的 `recentCloses`）。
- 密钥管理沿用 deploy 脚本的 `secret_text` / `inherit` binding 模式。

## 1. 交付物清单

| # | 文件 | 动作 |
|---|------|------|
| 1 | `ai-interpreter.js` | 新建。独立 ES module，含全部 AI 逻辑 |
| 2 | `subscription-worker.js` | 微改。仅 4 个挂钩点（见 §4） |
| 3 | `deploy-subscription-worker.js` | 微改。多模块上传 + 新增 2 个 binding（见 §5） |
| 4 | `docs/ai-interpreter-plan.md` | 本文档 + 验收记录（见 §6） |

## 2. 模块 `ai-interpreter.js` 设计

### 2.1 导出接口（唯一对外面）

```js
// 返回 HTML 片段字符串（可直接拼进邮件），或 null（表示无解读，邮件按原样发送）。
// 约定：本函数【永不 throw】，一切失败路径内部 catch 并返回 null。
export async function generateAlertInterpretation(env, subscription, alerts)
```

### 2.2 内部行为

1. **开关判定**：`env.ANTHROPIC_API_KEY` 未配置 → 立即返回 `null`（功能整体关闭，零成本、零副作用）。
2. **KV 缓存**：key 为 `ai:alert:${date}:${hash}`，`hash` 由 alerts 的 `alertKey` 列表（排序后）+
   `subscription.period/multiplier/condition` 拼接求 FNV-1a 短哈希（自实现，不引依赖）。
   命中直接返回；未命中调 API 后 `put(key, html, { expirationTtl: 86400 })`。
   作用：同一规则同一天触发多个订阅者时只调一次 API。
3. **调用 Claude**（原生 fetch，一封邮件一次调用，所有触发股票打包进同一个 prompt）：
   - endpoint `POST https://api.anthropic.com/v1/messages`，headers 含 `x-api-key`、
     `anthropic-version: 2023-06-01`、`anthropic-beta: server-side-fallback-2026-07-01`。
   - body：`model`（默认 `claude-opus-5`，`env.ANTHROPIC_MODEL` 可覆盖，不加日期后缀）、
     `max_tokens: 2000`、`fallbacks: "default"`（安全分类器拒答时服务端自动降级换模型重试，
     保证无人值守 cron 场景下尽量有产出）、`system`、`messages`。
   - **不传** `thinking`（该模型默认即自适应思考），**不传** `temperature`（会 400）。
   - 超时 `AbortSignal.timeout(60_000)`。
   - 响应处理顺序：`!response.ok` → warn + `null`；`stop_reason === "refusal"` → `null`；
     然后取 `content` 中所有 `type === "text"` 块拼接（不是只取 `content[0]`）；文本为空 → `null`。
4. **输出安全**：模型只输出纯文本；代码侧做 HTML 实体转义（`& < > " '`），按空行切段包 `<p>`，
   套进固定样式容器 div，并由**代码**在末尾固定追加免责声明：
   `本解读由 AI 自动生成，仅供参考，不构成任何投资建议。`
   模型输出永远不作为 HTML 直接注入。
5. **任何异常**（网络错误、超时、JSON 解析失败、KV 读写失败）→ `console.warn("[ai-interpreter]", err)` + 返回 `null`。

### 2.3 增强上下文

`fetchStockSnapshot` 返回对象**追加字段** `recentCloses: rows.slice(-20).map((r) => ({ date: r.date, close: r.close }))`。
纯新增字段，不影响任何现有消费方（snapshot 仅用于渲染邮件，不写 KV、不进 API 响应）；
alert 对象经 `evaluateAlert` 的 `...snapshot` 展开自动带上该字段。

## 3. Prompt 设计

SYSTEM_PROMPT 约束（写死在 `ai-interpreter.js`）：纯文本输出、每只股票 2–3 句技术含义、
最后一段讲共性或值得关注的技术位、只做客观技术描述不预测涨跌不给买卖建议、全文不超过 300 字。

`buildUserPrompt` 把 `{ rule: {period, multiplier, condition}, alerts: [...] }` 序列化为 JSON，
alert 只挑需要的字段（name/code/date/close/middle/standardDeviation/side/boundary/sigmaOffset/recentCloses），
数值保留 3 位小数以省 token。

## 4. `subscription-worker.js` 的 4 个挂钩点（改动全集）

1. 文件头部：`import { generateAlertInterpretation } from "./ai-interpreter.js";`
2. `fetchStockSnapshot` 返回对象追加 `recentCloses`（§2.3）。
3. `sendDueAlerts` 中发信前先取解读：
   ```js
   const aiHtml = await generateAlertInterpretation(env, subscription, newAlerts); // 内部永不 throw
   await sendAlertEmail(env, subscription, newAlerts, undefined, aiHtml);
   ```
4. `sendAlertEmail` / `renderAlertEmail` 各追加可选尾参 `aiHtml = null`；
   `renderAlertEmail` 在表格之后、灰色注释行之前插入 `${aiHtml || ""}`（紧贴 `</table>`，
   保证 `aiHtml` 为 null 时渲染结果与改动前**逐字节一致**）。

## 5. `deploy-subscription-worker.js` 的改动

1. **多模块上传**：metadata 的 `main_module` 仍是 `subscription-worker.js`，
   multipart 中额外追加 `ai-interpreter.js` 分片（`application/javascript+module`），
   模块名与 Worker 里的相对 import 说明符一致。
2. **两个新 binding**（都可选）：`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`。
   沿用既有语义：显式提供环境变量 → `secret_text` 覆盖；否则 `inherit` 继承上次部署的值。
3. **inherit 安全性**：上传前先查 `GET /workers/scripts/{name}/settings` 拿到已有 binding 名单，
   只对确实存在的 binding 发 `inherit`（inherit 一个不存在的 binding 会让整次上传失败）。
   404（脚本尚未创建）→ 视为空集合；查询本身失败 → 未知，对三个既有 binding 沿用旧行为（照发 inherit）。
4. 部署输出增加 `aiInterpreter` 一行，提示 AI 解读的 key 是否在本次部署中更新。

## 6. 验收记录

实现于 2026-08-25，全部验证在本地以 mock（假 Anthropic / Resend / Cloudflare API）完成，未产生真实 API 调用与费用。

**零影响验证**
- `renderAlertEmail(sub, alerts)` 与 `renderAlertEmail(sub, alerts, null)` 的输出，和改动前版本的输出
  **字符串全等**（`===`）——省略尾参、显式传 null 两种调用方式都逐字节一致。
- `git diff subscription-worker.js` 只含 §4 列出的 4 处改动，无其他函数体变动。
- snapshot 的 `recentCloses` 仅存在于内存渲染链路：全仓检索确认 snapshot 不写 KV、不进任何 HTTP 响应体。

**模块行为验证**（`ai-interpreter.js`，逐条 mock）
| 场景 | 结果 |
|------|------|
| 未配置 `ANTHROPIC_API_KEY` | 返回 null，且未发起任何 fetch / KV 访问 |
| `alerts` 为空数组 | 返回 null |
| 正常响应 | 生成解读 HTML；`<b>bold</b>`、`&`、`"` 被正确转义；空行切成 2 个 `<p>`；免责声明由代码追加 |
| 请求体校验 | `model=claude-opus-5`、`fallbacks="default"`、`anthropic-beta: server-side-fallback-2026-07-01`、`max_tokens=2000`，未出现 `thinking` / `temperature` |
| prompt 内容 | 数值截断到 3 位（12.3456789 → 12.346），含 `recentCloses` |
| 同规则第二次调用 | 命中 KV 缓存，未新增 API 调用 |
| `stop_reason: "refusal"` | 返回 null（warn 记录 category） |
| HTTP 500 | 返回 null |
| fetch 抛异常（网络中断） | 返回 null |
| KV get/put 抛异常 | 仍返回解读 HTML（缓存失败不影响主流程） |
| 无 `SUBSCRIPTIONS` binding | 仍返回解读 HTML |
| 文本块为空（如 `stop_reason: "max_tokens"`） | 返回 null |

**链路验证**：按 `sendDueAlerts` 的调用方式跑通 `generateAlertInterpretation` → `sendAlertEmail`，
Resend 收到的 HTML 中解读块位于表格之后、灰色注释行之前；`aiHtml` 为 null 时邮件不含解读块。

**部署脚本验证**（假 Cloudflare API 干跑 4 种场景）
| 场景 | bindings |
|------|----------|
| 脚本已存在，未给环境变量（已有 RESEND_API_KEY / ALERT_SECRET / ANTHROPIC_API_KEY） | KV + 三者 inherit |
| 脚本不存在（settings 404） | 仅 KV（不发任何 inherit，避免上传失败） |
| settings 查询 500（未知） | KV + 三个既有 binding inherit（与改动前行为一致） |
| 提供 `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | 两者 secret_text 覆盖 |

四种场景的 multipart 分片均为 `["metadata", "subscription-worker.js", "ai-interpreter.js"]`，
`main_module` 保持 `subscription-worker.js`。

**已知取舍**
- `max_tokens: 2000` 与计划一致；Opus 5 默认开启自适应思考，思考 token 与输出共享该额度。
  若未来解读被截断（`stop_reason: "max_tokens"` 且文本为空），模块会安全返回 null（邮件照常发出），
  届时可调高该常量或改用 `env.ANTHROPIC_MODEL` 指定更便宜/更短的模型。
- 成本：单封邮件一次调用，约 1.5K 入 + 0.5K 出，`claude-opus-5`（$5/$25 每百万 token）下不到 $0.02；
  KV 缓存使同规则同日的多个订阅者共用一次调用。
