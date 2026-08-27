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
