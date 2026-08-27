# 实施计划：历史信号上下文模块（signal-context，第三步）

> 本文档是给实现者（人或 agent）的完整施工图。目标：让第二步积累的 D1 历史数据产生价值——预警邮件附带**纯代码计算的派生信号**（连续触轨天数、带宽收窄/放大、偏离分位），并把这些信号喂给 AI 解读作为历史上下文。
> **最高原则：独立新模块，任何情况下不得影响现有功能** —— D1 不可用或历史数据不足时，邮件与今天完全一致。

## 0. 背景与依赖（实现前必读）

- **基于默认分支 `claude/push-local-project-wjgifw` 最新提交开发**（已含第一步 ai-interpreter、第二步 snapshot-store 及 #5/#6/#7 修复）。
- 现状事实（挂钩点所在，行号以默认分支当前为准）：
  - `sendDueAlerts`（subscription-worker.js 约 L1210）触发链：`const aiHtml = await generateAlertInterpretation(env, subscription, newAlerts); await sendAlertEmail(env, subscription, newAlerts, undefined, aiHtml);`
  - `renderAlertEmail(subscription, alerts, aiHtml = null)` 已有可选尾参，AI 块插在 `</table>` 之后。
  - `ai-interpreter.js`：导出 `generateAlertInterpretation(env, subscription, alerts)`（L243）；`buildUserPrompt(subscription, alerts)`（L64）把 alerts 序列化进 user prompt；`SYSTEM_PROMPT`（L27）；已有 DeepSeek/Anthropic 双供应商抽象 `pickProvider`——**供应商层完全不动**。
  - D1 表（snapshot-store 建）：`daily_indicators(code, trade_date, period, close, middle, stddev, sigma_offset, bandwidth_pct)` PK `(code, trade_date, period)`；`sector_daily(bk, trade_date, name, index_value, member_count)`。
  - alert 对象含 `code / multiplier / condition / side / sigmaOffset / recentCloses` 等字段。
- 项目约束不变：零依赖、无构建步骤、原生 Worker API；新模块经部署脚本 `extraModuleFiles` 注册。

## 1. 交付物清单

| # | 文件 | 动作 |
|---|------|------|
| 1 | `signal-context.js` | **新建**。独立 ES module：D1 只读查询 + 派生信号计算 + 信号区块 HTML 渲染 |
| 2 | `subscription-worker.js` | 微改。仅 4 个挂钩点（见 §5） |
| 3 | `ai-interpreter.js` | 微改。仅 3 个挂钩点（见 §6）——本期允许改它，这正是"第三步的事" |
| 4 | `deploy-subscription-worker.js` | 一行：`extraModuleFiles` 追加 `"signal-context.js"` |
| 5 | `docs/signal-context-plan.md` | 本文档，实现后在末尾附验收记录 |

## 2. 新模块 `signal-context.js` 接口

```js
// 均【永不 throw】。env.DB 缺失、查询失败、数据不足 → 返回 null（或该股票条目缺省）。
export async function buildSignalContext(env, alerts, period)
// → { byCode: { [code]: SignalEntry }, generatedAt } 或 null（完全不可用时）

export function renderSignalContextHtml(context, alerts)
// → 纯代码渲染的"历史信号"HTML 区块字符串，或 null（context 为 null / 无任何条目时）
```

`SignalEntry` 结构（每只触发股票一条；单项算不出就置 null，不影响其他项）：

```js
{
  code, asOf,                  // asOf = 该股票 daily_indicators 最新 trade_date
  streakDays,                  // 连续触轨天数：从最新日往回数 |sigma_offset| >= multiplier 的连续日数，
                               //   按 alert.side 方向计（高于上轨数 sigma_offset >= m；低于下轨数 <= -m）
  bandwidthChg5d,              // 带宽 5 日变化率：(最新 bandwidth_pct / 5 个交易日前 - 1)，正=放大 负=收窄
  bandwidthPctile120,          // 最新 bandwidth_pct 在近 120 个交易日中的分位（0–100）
  sigmaPctile250,              // 最新 |sigma_offset| 在近 250 个交易日中的分位（0–100）
  dataDays                     // 参与计算的历史行数（供"数据不足"判断与展示）
}
```

## 3. 计算与查询设计

- **单条只读 SQL / 股票**：`SELECT trade_date, sigma_offset, bandwidth_pct FROM daily_indicators WHERE code = ? AND period = ? ORDER BY trade_date DESC LIMIT 250`，其余全部在 JS 内存中算（数据量 ≤ 250 行/股，无需再查）。
- **period 选择**：用订阅的 `period`（`sendDueAlerts` 里可得）。该 `(code, period)` 组合在 D1 无数据（订阅新周期、快照还没跑）→ 该股票条目为 null。
- **数据不足判据**：行数 < 30 → 整条 `SignalEntry` 置 null（新回填的库、刚加的自选，宁缺毋滥不给误导性分位）。`streakDays` 另有下限：行数 < streak+1 时如实给出但标注 `dataDays`。
- **日期连续性**：`trade_date` 序列直接按行序视为连续交易日（表里只有交易日），不做日历对齐。
- **性能**：只在预警触发时调用（一封邮件 ≤ 订阅股票数条查询，实际是触发子集），D1 读免费额度百万级/天，可忽略。
- **可选加分项（做不做由实现者视工作量定，不做不算不合格）**：板块联动——从 KV `sector:ranking:{bk}`（tracked 板块成分缓存）反查触发股票所属板块，取 `sector_daily` 近 5 日 `index_value` 变化率，附进 `SignalEntry.sectorChg5d` 与渲染。查不到映射就跳过。

## 4. 渲染设计（`renderSignalContextHtml`）

- 输出与现有邮件风格一致的小表格或列表，标题"历史信号（近一年）"，每只股票一行，例如：
  `寒武纪 688256 · 连续第 3 日高于上轨 · 带宽 5 日 -12%（收窄，120 日分位 18%）· 偏离度处近 250 日 96% 分位 · 数据 250 日`
- 全部数值由代码格式化与 HTML 转义；**不经过任何模型**。null 项直接省略该短语；整条 null 的股票不出现；所有股票都 null → 函数返回 null，邮件不含该区块。
- 底部小字注明：`基于每日快照库计算，仅描述历史统计，不构成投资建议。`

## 5. `subscription-worker.js` 的 4 个挂钩点（改动全集，不得超出）

1. 文件头部：`import { buildSignalContext, renderSignalContextHtml } from "./signal-context.js";`
2. `sendDueAlerts` 中，现有两行改为：
   ```js
   const signalContext = await buildSignalContext(env, newAlerts, subscription.period); // 永不 throw
   const signalHtml = renderSignalContextHtml(signalContext, newAlerts);
   const aiHtml = await generateAlertInterpretation(env, subscription, newAlerts, signalContext);
   await sendAlertEmail(env, subscription, newAlerts, undefined, aiHtml, signalHtml);
   ```
3. `sendAlertEmail` / `renderAlertEmail` 各追加可选尾参 `signalHtml = null`；`renderAlertEmail` 的插入顺序为：`</table>` → `${signalHtml || ""}` → `${aiHtml || ""}` → 灰色注释行。两个尾参都为 null 时输出与当前版本**逐字节一致**。
4. `fetch` 路由表新增 `/api/signal-context`（GET，公开只读）：参数 `code`（必填）、`period`（默认 20）、`multiplier`（默认 2，算 streak 用，方向按 sigma_offset 符号自动取当前侧）；内部构造单元素伪 alert 调 `buildSignalContext`，返回 `{ code, period, entry }`，`Cache-Control: public, max-age=600`；`env.DB` 缺失返回 503。用于验收与未来前端。

**明确不改**：`evaluateAlert` 与任何触发/去重逻辑——信号只增强展示与 AI 上下文，**不改变是否发信**。

## 6. `ai-interpreter.js` 的 3 个挂钩点（改动全集，不得超出）

1. `generateAlertInterpretation(env, subscription, alerts)` → `generateAlertInterpretation(env, subscription, alerts, signalContext = null)`。第 4 参可选，所有既有行为在 null 时不变。
2. `buildUserPrompt(subscription, alerts)` → 追加可选参 `signalContext`：每只 alert 的 JSON 条目并入对应 `SignalEntry`（字段名照 §2，数值 3 位小数）；`signalContext` 为 null 或该 code 无条目时该字段整体省略。
3. `SYSTEM_PROMPT` 末尾追加一句：`输入可能附带历史派生信号（streakDays 连续触轨天数、bandwidthChg5d 带宽5日变化、bandwidthPctile120/sigmaPctile250 分位）；提供了就必须在解读中引用它们，说明当前触发在历史中的位置。`
4. **不改**：KV 缓存 key 的 hash 算法保持不变——同一 `(日期, alertKeys, 规则)` 下 signalContext 是确定的（同一天快照库状态一致），纳入 hash 只会白白打散缓存。供应商抽象（pickProvider / 两个 provider）一行不动。

## 7. `deploy-subscription-worker.js` 改动

仅一行：`const extraModuleFiles = ["ai-interpreter.js", "snapshot-store.js", "signal-context.js"];`
无新 binding、无新环境变量。

## 8. 明确不做（Out of scope）

- 不改变预警触发/去重/发送行为（`evaluateAlert`、`lastAlertKeys` 一概不动）。
- 不做情绪/资金/新闻等新数据源（第四步）。
- 不做前端 UI。
- 不动 KV 结构、不加新表（只读现有 D1 表）。
- 不引入 npm 依赖或构建步骤。

## 9. 验收标准（实现者自测清单）

- [ ] `node --check` × 4（subscription-worker / signal-context / ai-interpreter / deploy 脚本）全部通过。
- [ ] **回归**：无 `DB` binding 时 `buildSignalContext` 返回 null、`renderSignalContextHtml(null)` 返回 null，`renderAlertEmail(sub, alerts)` 输出与改动前**逐字节一致**；AI 关闭 + D1 关闭时整封邮件与第二步合并后的版本一致。
- [ ] **计算正确性**（构造已知序列断言）：连续触轨天数（含正好 1 天、跨侧中断归零）、带宽 5 日变化率符号与数值、分位数边界（最小值→0 附近、最大值→100 附近）。
- [ ] **数据不足**：`(code, period)` 行数 29 → 条目 null；行数 30 → 正常产出。
- [ ] **prompt 注入**：mock 供应商捕获请求体，确认 `SignalEntry` 字段出现在 user prompt JSON、SYSTEM_PROMPT 含新增句；`signalContext=null` 时请求体与改动前一致。
- [ ] **渲染安全**：构造含 `<script>`/`&` 的股票名，信号区块中被实体转义。
- [ ] **端点**：`/api/signal-context?code=...` 有数据返回 entry、无 DB 返回 503、缺 code 返回 400。
- [ ] 部署脚本 dry-run：formData 含 4 个模块文件。
- [ ] `git diff` 确认 subscription-worker.js / ai-interpreter.js 改动严格限于 §5/§6 列出的挂钩点。

## 10. 上线步骤与回滚

1. 前提：第二步已在真实环境完成首跑（D1 已有回填数据）；否则信号全为 null，邮件自动与现状一致，不出错但也无增量。
2. 合并后 `node deploy-subscription-worker.js` 部署（无新配置）。
3. `POST /api/send-alerts`（Bearer ALERT_SECRET）强制触发一轮，检查邮件中"历史信号"区块与 AI 解读是否引用了信号。
4. `GET /api/signal-context?code=<自选股>` 抽查数值与 `/api/snapshot-history` 的原始序列对得上。
5. 回滚：本模块无独立开关；如需下线，恢复 §5/§6 挂钩点的两行调用并重部署即可（模块文件留着无副作用）。极端情况下 `DISABLE_D1=1` 重部署也会让信号整体退化为 null，邮件回到现状。

---

## 11. 验收记录（实现后补，逐项对应 §9）

实现基线：默认分支 `claude/push-local-project-wjgifw` 最新提交 `14f555a`（含 #5/#6/#7/#9 修复）。
验收方法：Node v22 下用**假 D1**（`prepare().bind().all()` 同形）、**假 KV**、**打桩 `globalThis.fetch`**
（拦截新浪日线 / Resend / DeepSeek）跑模块级与挂钩点级断言；把改动前的
`subscription-worker.js` / `ai-interpreter.js`（`git show HEAD:`）也装进一份并行的模块目录，
两边跑同一组输入做**逐字节对比**。验收脚本按 §1 交付物清单未入库，构成如上，可复现。

### 逐项结果

| § 9 项 | 结果 | 证据 |
|---|---|---|
| `node --check` × 4 | ✅ | `subscription-worker.js` / `signal-context.js` / `ai-interpreter.js` / `deploy-subscription-worker.js` 全部通过 |
| 回归：无 `DB` → 信号为 null、邮件逐字节一致 | ✅ | 10/10。`buildSignalContext({}, …)`、`(undefined, …)`、查询抛错、`no such table` 四条路径全部返回 `null`；`renderSignalContextHtml(null / undefined / {byCode:{}} / {byCode:{code:null}})` 全部返回 `null`；`renderAlertEmail(sub, alerts)`、`(…, null, null)`、`(…, aiHtml)` 三种调用与改动前**逐字节相等**；走完整 `sendDueAlerts`（AI 关 + D1 关）捕获 Resend 请求体，`html` 与 `subject` 与改动前**逐字节相等** |
| 计算正确性（构造已知序列断言） | ✅ | 17/17。连续触轨：正好 1 天 / 连续 3 天后中断 / 跨侧中断归零 / 下轨方向按 `<= -m` 计 / 边界 `sigma == multiplier` 计入；带宽 5 日变化率：`0.088/0.1-1 = -0.12`（收窄，负号）、`0.125/0.1-1 = +0.25`（放大，正号）、确认比较的是 `rows[5]`、5 日前为 0 时置 `null` 不产生 `Infinity`；分位：窗口最小值 `< 1`、最大值 `> 99`、窗口确实只截最近 120 / 250 行（第 121 行起的极端值不参与）、σ 分位取绝对值（下轨深跌同样落高分位）；`asOf` / `dataDays` / 250 行查询上限 |
| 数据不足：29 → null，30 → 正常 | ✅ | 6/6。29 行 → 条目 `null`（全为 null 时整体返回 `null`）；30 行 → 有条目且 `dataDays === 30`；`(code, period)` 组合无数据时**只有该股票**为 `null`，同批其它股票照常产出；`period` 走订阅周期（60 有数据 / 20 没有可区分）；非法 `period` 回落 20；同一 code 多条预警只发一次查询 |
| prompt 注入 | ✅ | 6/6。mock 供应商捕获请求体：`SYSTEM_PROMPT` 含新增句与四个字段名；`signal` 出现在 user prompt 的 alert 条目内，数值 3 位小数（`-0.1234567 → -0.123`、`18.3333 → 18.333`）；`signalContext = null` 时 **user prompt 与改动前逐字节相等**、`model`/`max_tokens`/`stream` 不变；该 code 无条目时 `signal` 字段整体省略；**KV 缓存 key 在 `null` 与有信号两种调用下完全相同**（未被打散） |
| 渲染安全 | ✅ | 8/8。`name` 为 `` `<script>alert(1)</script>&"'` `` 时输出为 `&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;`，原始 `<script>` 不出现；非法 code（`<img src=x onerror=1>`）不产出区块；`streakDays === 0` 不渲染该短语；只剩"名字 + 数据 N 日"的条目不占行；畸形输入（`byCode: null` / `alerts: null` / `[]`）不 throw |
| 端点 `/api/signal-context` | ✅ | 10/10。无 `DB` → 503；缺 `code` → 400；`period=1` → 400；`multiplier=0` → 400；有数据 → 200 + `entry` + `Cache-Control: public, max-age=600`；无数据 → **200 + `entry: null`**（不是 500，与 #5 同源）；方向按最新 `sigma_offset` 符号自动取当前侧（负 → 数下轨）；`multiplier=2 → streak 3`、`multiplier=2.5 → streak 1`；`period` 透传；查询抛错 → 200 + `entry: null` |
| 部署脚本 dry-run | ✅ | 3 个场景全部上传 **4 个模块文件**（`subscription-worker.js` / `ai-interpreter.js` / `snapshot-store.js` / `signal-context.js`），`main_module` 不变：默认 → bindings `SUBSCRIPTIONS,DB`；`DISABLE_D1=1` → bindings `SUBSCRIPTIONS`（无 D1，信号自动退化为 null）；配 `DEEPSEEK_API_KEY` → 追加该 binding。上传的 `signal-context.js` 内容经内容断言核对 |
| `git diff` 改动严格限于 §5/§6 | ✅ | 见下表 |

另加 4 条端到端挂钩链断言（超出 §9，用来证明四个挂钩点确实接上了）：
D1 开 + AI 开时邮件出现"历史信号"区块且位置为 `</table>` → 信号 → AI 解读，AI 请求体带上 `signal`
（`streakDays: 2`、`dataDays: 250`）；D1 查询整体失败、以及 D1 有 binding 但历史只有 29 行时，
邮件与改动前**逐字节一致**；两种情况下 `lastAlertKeys` 与改动前**完全相同**（触发/去重行为未变）。

**合计 60 / 60 通过**（模块级 + 挂钩点级 + 端到端），另加 `node --check` × 4 与部署 dry-run × 3。

### 改动全集核对（`git diff --stat`）

| 文件 | 改动 | 是否在 §5/§6/§7 清单内 |
|---|---|---|
| `signal-context.js` | 新建（380 行） | §1 第 1 项 |
| `subscription-worker.js` | +13 / −7 | 4 处：① 头部 import；② `sendDueAlerts` 两行 → 四行；③ `renderAlertEmail` / `sendAlertEmail` 各追加尾参 `signalHtml = null` 并把插入点改成 `</table>${signalHtml \|\| ""}${aiHtml \|\| ""}`；④ 路由表新增 `/api/signal-context`。`evaluateAlert`、`lastAlertKeys`、任何触发/去重/发送逻辑**一行未动** |
| `ai-interpreter.js` | +40 / −20 | 3 处 + 1 句：① `generateAlertInterpretation` 追加第 4 参 `signalContext = null`（并透传给 `requestInterpretation`）；② `buildUserPrompt` 追加可选参与 `signalFor()` 辅助函数；③ `SYSTEM_PROMPT` 末尾追加一句。`pickProvider` 与两个 provider、`cacheKeyFor` / `shortHash` **一行未动** |
| `deploy-subscription-worker.js` | +1 / −1 | §7：`extraModuleFiles` 追加 `"signal-context.js"` |

`buildUserPrompt` 里 alert 条目的字段顺序保持原样、`signal` 追加在末尾，因此
`signalContext = null` 时 `JSON.stringify` 的输出与改动前完全相同（已由逐字节断言覆盖）。

### 实现中发现并修复的一个真实缺陷

`numberOrNull(value)` 最初照抄 `snapshot-store.js` 的写法 `Number.isFinite(Number(value)) ? … : null`。
但 `Number(null) === 0`：D1 里 `sigma_offset`（`stddev` 为 0 时）与 `bandwidth_pct`（`middle` 为 0 时）
都是**可空列**，照抄的写法会把 NULL 读成真实的 0，污染分位样本、并让"连续触轨天数"在停牌/一字板
那类零波动日上得到错误结论。已改为先挡掉 `null / undefined / ""` 再转数字，并在代码里写明原因。
对应断言："`bandwidth_pct` 全为 NULL 时该项为 `null`，σ 相关项照算"。

### 与计划的差异 / 未做的部分（如实说明）

- **§3 的可选加分项（板块联动 `sectorChg5d`）未做**。计划明确"不做不算不合格"。理由：需要从 KV
  `sector:ranking:{bk}` 反查股票→板块映射，而 §8 复盘已记录**板块刷新链路本身当前就不工作**
  （`sector_daily` 至今 0 行、多数 `sector:bollinger:*` 缓存停在 7 月），此时接进来只会引入一个
  恒为空的字段和额外的 KV 读。等板块刷新拆片修好后再补，成本更低、也能真的验证。
- **端点的 `handleSignalContext` 实现在 `signal-context.js` 里**，主 Worker 的挂钩点只有一行路由
  （与 `handleSnapshotHistory` 的既有写法一致），这样 §5 的"改动全集"才真的只有 4 处。
- **渲染窗口标签随实际数据量收窄**：`dataDays < 120` 时显示"…日分位"用的是 `min(dataDays, 120)`，
  不会在只有 45 天数据时谎称"120 日分位"。`SignalEntry` 的字段名仍照 §2 不变（窗口大小由
  `dataDays` 推得，未新增字段）。
- 验收全部是**仿真**：假 D1 与打桩 fetch，没有连真的 Cloudflare D1 / 新浪 / Resend / DeepSeek。
  SQL 形状、响应形状按线上对齐，但真实 D1 的读延迟与真实历史数据的数值合理性，仍需按 §10
  上线步骤在真环境跑一轮 `POST /api/send-alerts` 与 `GET /api/signal-context` 抽查确认。
