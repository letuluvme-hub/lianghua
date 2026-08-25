# 实施计划：预警邮件 AI 解读模块（ai-interpreter）

> 本文档是给实现者（人或 agent）的完整施工图。目标：在现有布林带预警邮件中附加一段由 Claude 生成的自然语言解读。
> **最高原则：新增一个独立模块，任何情况下不得影响现有功能** —— AI 不可用时，系统行为与今天完全一致。

## 0. 背景与现状（实现前必读）

- `subscription-worker.js` 是一个**零依赖、单文件 ES module** 的 Cloudflare Worker，由 `deploy-subscription-worker.js` 通过 Cloudflare API multipart 上传部署（`main_module`），**没有 package.json、没有构建步骤**。
  - 因此**不能引入 npm 依赖**（包括 Anthropic 官方 SDK）。调用 Claude 必须用 Worker 原生 `fetch` 直连 Anthropic REST API（`POST https://api.anthropic.com/v1/messages`）。
- 预警链路（本次要挂钩的地方）：
  - `sendDueAlerts(env, force)`（约 L1177）：cron 每分钟触发，遍历 KV 中 `alert:` 前缀的订阅 → `fetchStockSnapshot` 拉行情 → `evaluateAlert` 判定触发 → 有新触发时 `sendAlertEmail`。
  - `sendAlertEmail(env, subscription, alerts, subjectPrefix)`（约 L994）→ `renderAlertEmail(subscription, alerts)` 生成 HTML 表格 → `sendResendEmail` 经 Resend 发信。
  - 单条 alert 对象字段：`{ code, name, date, close, middle, standardDeviation, bands: {1:{upper,lower},2:{...},3:{...}}, multiplier, condition, side, boundary, distance, sigmaOffset, alertKey }`。
- 密钥管理：deploy 脚本用 `secret_text` / `inherit` binding 模式（见 `RESEND_API_KEY` 的处理），新密钥照抄该模式。

## 1. 交付物清单

| # | 文件 | 动作 |
|---|------|------|
| 1 | `ai-interpreter.js` | **新建**。独立 ES module，含全部 AI 逻辑 |
| 2 | `subscription-worker.js` | 微改。仅 4 个挂钩点（见 §4），不动任何现有函数体逻辑 |
| 3 | `deploy-subscription-worker.js` | 微改。多模块上传 + 新增 2 个 binding（见 §5） |
| 4 | `docs/ai-interpreter-plan.md` | 本文档，实现后在末尾附验收记录 |

## 2. 新模块 `ai-interpreter.js` 设计

### 2.1 导出接口（唯一对外面）

```js
// 返回 HTML 片段字符串（可直接拼进邮件），或 null（表示无解读，邮件按原样发送）。
// 约定：本函数【永不 throw】，一切失败路径内部 catch 并返回 null。
export async function generateAlertInterpretation(env, subscription, alerts)
```

### 2.2 内部行为

1. **开关判定**：`env.ANTHROPIC_API_KEY` 未配置 → 立即返回 `null`（功能整体关闭，零成本、零副作用）。
2. **KV 缓存**：key 为 `ai:alert:${date}:${hash}`，`hash` 由 `alerts` 的 `alertKey` 列表 + `subscription.period/multiplier/condition` 排序后拼接求短哈希（自实现 djb2/fnv 即可，不引依赖）。命中直接返回；未命中调 API 后 `env.SUBSCRIPTIONS.put(key, html, { expirationTtl: 86400 })`。作用：同一规则同一天触发多个订阅者时只调一次 API。
3. **调用 Claude（原生 fetch，一封邮件一次调用，所有触发股票打包进同一个 prompt）**：

```js
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "server-side-fallback-2026-07-01",
  },
  body: JSON.stringify({
    model: env.ANTHROPIC_MODEL || "claude-opus-5",
    max_tokens: 2000,
    fallbacks: "default",          // 安全分类器拒答时服务端自动降级换模型重试，
                                   // 保证无人值守 cron 场景下尽量有产出
    system: SYSTEM_PROMPT,         // 见 §3
    messages: [{ role: "user", content: buildUserPrompt(subscription, alerts) }],
  }),
  signal: AbortSignal.timeout(60_000),
});
```

  要点：
  - 模型默认 `claude-opus-5`（$5/$25 每百万 token；单次调用约 1.5K 入 + 0.5K 出 ≈ **不到 $0.02**）。`env.ANTHROPIC_MODEL` 可覆盖（如降本用 `claude-haiku-4-5`）。**不要**给模型 ID 加日期后缀。
  - **不要**传 `thinking` 参数（该模型默认即自适应思考），**不要**传 `temperature`。
  - 响应处理顺序：`!response.ok` → warn + `null`；解析 JSON 后先查 `stop_reason`，为 `"refusal"` → `null`；然后取 `content` 数组中所有 `type === "text"` 块的 `text` 拼接（不要只取 `content[0]`）。
4. **输出安全（重要）**：让模型输出**纯文本**（见 §3 的格式约定），代码侧做 HTML 实体转义（`& < > " '`），按空行切段包 `<p>` 标签，套进固定样式的容器 div，并由**代码**（不是模型）在末尾固定追加免责声明行：`本解读由 AI 自动生成，仅供参考，不构成任何投资建议。`。模型输出永远不作为 HTML 直接注入。
5. **任何异常**（fetch 网络错误、超时、JSON 解析失败、KV 读写失败）→ `console.warn("[ai-interpreter]", err)` + 返回 `null`。

### 2.3 增强上下文（小改动，强烈建议做）

`fetchStockSnapshot`（subscription-worker.js 约 L291）的返回对象**追加一个字段** `recentCloses: rows.slice(-20).map((r) => ({ date: r.date, close: r.close }))`。这是纯新增字段，不影响任何现有消费方；有了近 20 日收盘序列，AI 才能说出"连续 N 日贴上轨/带宽收窄"这类真正有信息量的话。alert 对象经 `evaluateAlert` 的 `...snapshot` 展开自动带上该字段。

## 3. Prompt 设计（写进 `ai-interpreter.js` 的常量）

**SYSTEM_PROMPT（初稿，实现时可微调措辞但不得改变约束）：**

```
你是一名量化技术分析助手，为个人投资者的布林带预警邮件撰写简短解读。
输入是 JSON：触发预警的股票列表，含收盘价、布林带中线/标准差/上下轨、σ偏离、近20日收盘序列，以及订阅规则（周期N、倍数K、触发条件）。

要求：
- 输出纯文本，不要 Markdown、不要 HTML 标签。段落之间用空行分隔。
- 每只触发股票 2-3 句：说明触发的技术含义（突破方向、偏离程度、结合近20日走势的位置，如带宽收窄/放大、是否连续多日触及轨道）。
- 最后 1 段（1-2 句）：若多只股票同时触发，指出共性；只有一只则给出后续值得关注的技术位。
- 只做技术面客观描述，不预测涨跌，不给出买入/卖出建议，不使用"建议""看好""看空"等措辞。
- 全文不超过 300 字。
```

**buildUserPrompt**：把 `{ rule: {period, multiplier, condition}, alerts: [...] }` 序列化为 JSON（alert 只挑需要的字段：name/code/date/close/middle/standardDeviation/side/boundary/sigmaOffset/recentCloses，数值 `toFixed(3)` 截断以省 token）。

## 4. `subscription-worker.js` 的 4 个挂钩点（改动全集，不得超出）

1. 文件头部新增：`import { generateAlertInterpretation } from "./ai-interpreter.js";`
2. `fetchStockSnapshot` 返回对象追加 `recentCloses` 字段（§2.3）。
3. `sendDueAlerts` 中，`await sendAlertEmail(env, subscription, newAlerts);` 改为：
   ```js
   const aiHtml = await generateAlertInterpretation(env, subscription, newAlerts); // 内部永不 throw
   await sendAlertEmail(env, subscription, newAlerts, undefined, aiHtml);
   ```
4. `sendAlertEmail` 与 `renderAlertEmail` 各追加一个**可选**尾参 `aiHtml = null`；`renderAlertEmail` 在表格之后、灰色注释行之前插入 `${aiHtml || ""}`。`aiHtml` 为 null 时渲染结果与现在**逐字节一致**。

（`/api/send-alerts` 强制触发端点走的也是 `sendDueAlerts`，自动获得 AI 解读，无需另改。）

**可选加分项**：新增路由 `/api/ai-preview`（POST，`Bearer ALERT_SECRET` 鉴权，照抄 `/api/send-alerts` 的鉴权写法），body 传 `{ codes: ["600183"], period, multiplier, condition }`，服务端拉快照→构造 alerts→返回 `{ html }`。用于不等 cron、不发邮件地人工验证 prompt 效果。

## 5. `deploy-subscription-worker.js` 改动

1. **多模块上传**：`uploadWorker` 里除 `subscription-worker.js` 外，再 `formData.append("ai-interpreter.js", new Blob([aiSource], { type: "application/javascript+module" }), "ai-interpreter.js")`。`main_module` 保持不变，Cloudflare 会按 import 路径解析同 form 内的其余模块。
2. **新增 bindings**（照抄 RESEND_API_KEY 的 secret_text/inherit 模式）：
   - `ANTHROPIC_API_KEY`（secret）：未设 env 时 inherit。
   - `ANTHROPIC_MODEL`（plain_text，可选）：仅当 `process.env.ANTHROPIC_MODEL` 存在时写入，否则 inherit。

## 6. 明确不做（Out of scope）

- 不改前端（`app.js` / `index.html` / `sectors.html`）。
- 不改任何现有 API 路由的请求/响应结构。
- 不动 KV 中既有数据结构（只新增 `ai:` 前缀的缓存 key，自带 TTL 过期）。
- 不引入 npm 依赖、不加构建步骤。
- 日报邮件（`sendDueSubscriptions`）本期不接 AI —— 日报是无条件全量发送，调用量和价值都不如预警；留到下期。

## 7. 验收标准（实现者自测清单）

- [ ] `node --check subscription-worker.js && node --check ai-interpreter.js && node --check deploy-subscription-worker.js` 全部通过。
- [ ] **回归**：不设 `ANTHROPIC_API_KEY` 时，`renderAlertEmail(sub, alerts)` 输出与改动前逐字节一致（用固定样例数据对比新旧函数输出验证）。
- [ ] **失败安全**：把 API 地址 mock 成必失败（或断网模拟），`sendDueAlerts` 仍正常发出无 AI 段落的邮件，仅留 warn 日志。
- [ ] **拒答安全**：构造 `stop_reason: "refusal"` 的假响应，返回 null，邮件正常。
- [ ] **转义**：让样例模型输出含 `<script>` 与 `&` 字符，确认邮件 HTML 中已被实体转义。
- [ ] **缓存**：同参数连续调用两次，第二次不发起 API 请求（可用计数或日志验证）。
- [ ] 部署脚本本地 dry-run（可临时注释 `api()` 实调，打印 formData keys 确认两个模块 + 新 bindings 齐全）。

## 8. 上线步骤

1. 合并后，在部署环境设置 `ANTHROPIC_API_KEY` 环境变量，运行 `node deploy-subscription-worker.js`。
2. 用 `/api/send-alerts`（Bearer ALERT_SECRET）强制触发一轮，检查收到的邮件中 AI 解读段落与免责声明。
3. 如需回滚/关停：不设 `ANTHROPIC_API_KEY` 重新部署（binding 写空值），或直接在 Cloudflare 后台删除该 secret —— 系统即回到纯规则模式。
