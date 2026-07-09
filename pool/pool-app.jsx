/* ============================================================
   股票池原型 · 主应用（babel / JSX）
   - 统一「我的股票池」侧栏面板（导入 / 搜索 / 分组 / 勾选）
   - 主区：股票池总览卡片（演示行情 + σ 仪表）
   依赖 window.PoolData, window.ImportModal, window.MarketBadge
   ============================================================ */
const { useState: useStateA, useMemo: useMemoA, useEffect: useEffectA } = React;
const P = window.PoolData;

const SEED_GROUPS = [
  { id: "g-ai", name: "AI·算力" },
  { id: "g-chip", name: "芯片半导体" },
  { id: "g-energy", name: "新能源·锂电" },
];

const SEED = [
  ...["688256", "688802", "688795", "688041", "002230", "000977", "603019", "688111", "300308", "300502", "601360", "002415"].map((c) => [c, "g-ai"]),
  ...["688981", "002371", "603501", "688012", "603986", "688008", "002049", "600584"].map((c) => [c, "g-chip"]),
  ...["300750", "002594", "300274"].map((c) => [c, "g-energy"]),
  ...["00700", "AAPL", "NVDA", "TSLA"].map((c) => [c, null]),
];

function makeStock(code, groupId) {
  const norm = P.normalizeSecurityCode(code) || code;
  return { code: norm, name: P.lookupName(norm), market: P.marketCategory(norm), groupId: groupId || null };
}

function Gauge({ sigma }) {
  if (sigma == null || Number.isNaN(sigma)) return <div className="gauge gauge--empty"></div>;
  const pct = Math.max(3, Math.min(97, ((sigma + 3.5) / 7) * 100));
  return (
    <div className="gauge">
      <div className="gauge-track">
        {[-3, -2, -1, 1, 2, 3].map((t) => (
          <span key={t} className="gauge-tick" style={{ left: `${((t + 3.5) / 7) * 100}%` }}></span>
        ))}
        <span className="gauge-mid" style={{ left: "50%" }}></span>
        <span className="gauge-marker" style={{ left: `${pct}%` }} title={`${sigma >= 0 ? "+" : ""}${sigma.toFixed(2)}σ`}></span>
      </div>
      <div className="gauge-scale"><span>−3σ</span><span>中线</span><span>+3σ</span></div>
    </div>
  );
}

function PoolRow({ stock, included, groups, onToggle, onSetGroup, onRemove }) {
  return (
    <div className={included ? "pool-row" : "pool-row excluded"}>
      <input type="checkbox" checked={included} onChange={() => onToggle(stock.code)} title="纳入订阅 / 预警" />
      <div className="pr-id">
        <span className="pr-name">{stock.name || <span className="pending">名称待获取</span>}</span>
        <div className="pr-sub">
          <span className="pr-code">{stock.code}</span>
          <window.MarketBadge code={stock.code} market={stock.market} />
        </div>
      </div>
      <div className="pr-tools">
        <select
          className="pr-group-select"
          value={stock.groupId || "__none__"}
          onChange={(e) => onSetGroup(stock.code, e.target.value === "__none__" ? null : e.target.value)}
          title="所属分组"
        >
          <option value="__none__">未分组</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button type="button" className="pr-remove" title="移出股票池" onClick={() => onRemove(stock.code)}>×</button>
      </div>
    </div>
  );
}

function StockCard({ stock, included, groupName, onToggle }) {
  const m = P.demoMetrics(stock.code);
  const zone = P.classifyBySigma(m.sigma);
  return (
    <button type="button" className={included ? "pf-card" : "pf-card excluded"} onClick={() => onToggle(stock.code)}>
      <div className="pf-card-top">
        <div className="pf-card-id">
          <span className="pf-name">{stock.name || stock.code}</span>
          <span className="pf-code">{stock.code}</span>
        </div>
        <span className={`zone-chip ${zone.cssClass}`}>{zone.label}</span>
      </div>
      <div className="ov-card-mk">
        <window.MarketBadge code={stock.code} market={stock.market} />
        <span className={groupName ? "ov-group-tag" : "ov-group-tag none"}>{groupName || "未分组"}</span>
      </div>
      <div className="pf-card-price">
        <strong>{P.formatNumber(m.close)}</strong>
        <span className="pf-sigma">{`${m.sigma >= 0 ? "+" : ""}${m.sigma.toFixed(2)}σ`}</span>
      </div>
      <Gauge sigma={m.sigma} />
      <div className="pf-card-bands">
        <div><span>中线</span><b>{P.formatNumber(m.middle)}</b></div>
        <div><span>±1σ</span><b>{`${P.formatNumber(m.bands[1].upper)}/${P.formatNumber(m.bands[1].lower)}`}</b></div>
        <div><span>状态</span><b style={{ color: included ? "var(--brand)" : "var(--ink-3)" }}>{included ? "已纳入" : "未纳入"}</b></div>
      </div>
    </button>
  );
}

function SubToggle({ title, summary, children }) {
  const [open, setOpen] = useStateA(false);
  return (
    <>
      <button type="button" className="collapse-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <strong>{summary}</strong>
        <span className="toggle-state">{open ? "收起" : "展开"}</span>
      </button>
      <div className={open ? "collapsible-body" : "collapsible-body collapsed"}>{children}</div>
    </>
  );
}

function App() {
  const [pool, setPool] = useStateA(() => SEED.map(([c, g]) => makeStock(c, g)));
  const [groups, setGroups] = useStateA(SEED_GROUPS);
  const [included, setIncluded] = useStateA(() => new Set(SEED.map(([c]) => P.normalizeSecurityCode(c) || c)));
  const [search, setSearch] = useStateA("");
  const [groupFilter, setGroupFilter] = useStateA("__all__");
  const [importOpen, setImportOpen] = useStateA(false);
  const [toast, setToast] = useStateA("");
  const [ovMarket, setOvMarket] = useStateA("ALL");
  const [quickOpen, setQuickOpen] = useStateA(false);
  const [quickVal, setQuickVal] = useStateA("");
  const [quickErr, setQuickErr] = useStateA(false);

  useEffectA(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const poolCodes = useMemoA(() => pool.map((s) => s.code), [pool]);
  const groupName = (id) => (groups.find((g) => g.id === id) || {}).name || "";

  const groupCounts = useMemoA(() => {
    const m = { __ungrouped__: 0 };
    groups.forEach((g) => (m[g.id] = 0));
    pool.forEach((s) => {
      const k = s.groupId && m[s.groupId] != null ? s.groupId : "__ungrouped__";
      m[k] += 1;
    });
    return m;
  }, [pool, groups]);

  const visible = useMemoA(() => {
    const q = search.trim().toLowerCase();
    return pool.filter((s) => {
      if (groupFilter === "__ungrouped__" && s.groupId) return false;
      if (groupFilter !== "__all__" && groupFilter !== "__ungrouped__" && s.groupId !== groupFilter) return false;
      if (!q) return true;
      return s.code.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q);
    });
  }, [pool, search, groupFilter]);

  // group the visible rows for the "all" view
  const groupedVisible = useMemoA(() => {
    if (groupFilter !== "__all__") return [{ id: null, name: null, rows: visible }];
    const buckets = [];
    groups.forEach((g) => {
      const rows = visible.filter((s) => s.groupId === g.id);
      if (rows.length) buckets.push({ id: g.id, name: g.name, rows });
    });
    const ungrouped = visible.filter((s) => !s.groupId);
    if (ungrouped.length) buckets.push({ id: "__ungrouped__", name: "未分组", rows: ungrouped });
    return buckets;
  }, [visible, groups, groupFilter]);

  const includedCount = useMemoA(() => pool.filter((s) => included.has(s.code)).length, [pool, included]);

  const ovStocks = useMemoA(() => {
    if (ovMarket === "ALL") return pool;
    return pool.filter((s) => s.market === ovMarket);
  }, [pool, ovMarket]);

  function toggleInclude(code) {
    setIncluded((cur) => {
      const next = new Set(cur);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function setStockGroup(code, groupId) {
    setPool((cur) => cur.map((s) => (s.code === code ? { ...s, groupId } : s)));
  }

  function removeFromPool(code) {
    setPool((cur) => cur.filter((s) => s.code !== code));
    setIncluded((cur) => { const n = new Set(cur); n.delete(code); return n; });
  }

  function selectAllVisible() {
    setIncluded((cur) => { const n = new Set(cur); visible.forEach((s) => n.add(s.code)); return n; });
  }
  function invertVisible() {
    setIncluded((cur) => { const n = new Set(cur); visible.forEach((s) => (n.has(s.code) ? n.delete(s.code) : n.add(s.code))); return n; });
  }
  function clearVisible() {
    setIncluded((cur) => { const n = new Set(cur); visible.forEach((s) => n.delete(s.code)); return n; });
  }

  function handleImport({ items, groupChoice, newGroupName, autoInclude }) {
    let targetGroupId = null;
    let label = "";
    if (groupChoice === "__new__" && newGroupName) {
      targetGroupId = P.uid("g");
      setGroups((cur) => [...cur, { id: targetGroupId, name: newGroupName }]);
      label = newGroupName;
    } else if (groupChoice !== "__none__") {
      targetGroupId = groupChoice;
      label = groupName(groupChoice);
    }
    const existing = new Set(pool.map((s) => s.code));
    const fresh = items.filter((it) => !existing.has(it.code)).map((it) => ({ code: it.code, name: it.name, market: it.market, groupId: targetGroupId }));
    setPool((cur) => [...cur, ...fresh]);
    if (autoInclude) {
      setIncluded((cur) => { const n = new Set(cur); fresh.forEach((s) => n.add(s.code)); return n; });
    }
    setImportOpen(false);
    setToast(`已导入 ${fresh.length} 只股票${label ? ` 到「${label}」` : ""}`);
  }

  function quickAdd() {
    const code = P.normalizeSecurityCode(quickVal);
    if (!code || pool.some((s) => s.code === code)) { setQuickErr(true); return; }
    const gid = groupFilter !== "__all__" && groupFilter !== "__ungrouped__" ? groupFilter : null;
    setPool((cur) => [...cur, makeStock(code, gid)]);
    setIncluded((cur) => new Set(cur).add(code));
    setQuickVal(""); setQuickErr(false); setQuickOpen(false);
    setToast(`已添加 ${P.lookupName(code) || code}`);
  }

  const allVisibleIncluded = visible.length > 0 && visible.every((s) => included.has(s.code));

  return (
    <main className="shell">
      {toast && <div className="pool-toast"><span className="dot"></span>{toast}</div>}
      <window.ImportModal open={importOpen} onClose={() => setImportOpen(false)} poolCodes={poolCodes} groups={groups} onImport={handleImport} />

      <section className="workspace">
        {/* ── 侧栏 ── */}
        <aside className="control-panel">
          <div className="brand">
            <span>BB</span>
            <div><h1>日布林带</h1><p>中线与 1/2/3 倍标准差轨道</p></div>
          </div>

          <div className="pool-panel">
            <div className="pool-head">
              <div className="pool-title">
                <h3>我的股票池</h3>
                <span className="pool-count">{pool.length} 只</span>
              </div>
              <div className="pool-actions">
                <button type="button" className="btn-import" onClick={() => setImportOpen(true)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  批量导入
                </button>
                <button type="button" className="btn-ghost" title="快速添加单个" onClick={() => setQuickOpen((o) => !o)}>＋</button>
              </div>
            </div>

            {quickOpen && (
              <div className="custom-stock-row">
                <input
                  value={quickVal}
                  autoFocus
                  placeholder="688256 / 00700 / AAPL"
                  style={quickErr ? { borderColor: "var(--danger)" } : null}
                  onChange={(e) => { setQuickVal(P.cleanSecurityInput(e.target.value)); setQuickErr(false); }}
                  onKeyDown={(e) => e.key === "Enter" && quickAdd()}
                />
                <button type="button" onClick={quickAdd}>添加</button>
              </div>
            )}

            <div className="pool-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input value={search} placeholder="搜索名称或代码…" onChange={(e) => setSearch(e.target.value)} />
            </div>

            <div className="pool-groups">
              <button type="button" className={groupFilter === "__all__" ? "pool-chip active" : "pool-chip"} onClick={() => setGroupFilter("__all__")}>全部 <span className="ct">{pool.length}</span></button>
              {groups.map((g) => (
                <button key={g.id} type="button" className={groupFilter === g.id ? "pool-chip active" : "pool-chip"} onClick={() => setGroupFilter(g.id)}>{g.name} <span className="ct">{groupCounts[g.id] || 0}</span></button>
              ))}
              {groupCounts.__ungrouped__ > 0 && (
                <button type="button" className={groupFilter === "__ungrouped__" ? "pool-chip active" : "pool-chip"} onClick={() => setGroupFilter("__ungrouped__")}>未分组 <span className="ct">{groupCounts.__ungrouped__}</span></button>
              )}
            </div>

            <div className="pool-selbar">
              <span>已勾选 <strong>{includedCount}</strong> / {pool.length} 只纳入订阅</span>
              <div className="pool-selbar-actions">
                <button type="button" className="linkbtn" onClick={allVisibleIncluded ? clearVisible : selectAllVisible}>{allVisibleIncluded ? "全不选" : "全选"}</button>
                <button type="button" className="linkbtn" onClick={invertVisible}>反选</button>
              </div>
            </div>

            <div className="pool-list">
              {visible.length === 0 ? (
                <div className="pool-empty">没有匹配的股票<br />试试调整搜索或分组筛选</div>
              ) : (
                groupedVisible.map((bucket) => (
                  <React.Fragment key={bucket.id || "single"}>
                    {bucket.name && <div className="pool-group-label">{bucket.name} · {bucket.rows.length}</div>}
                    {bucket.rows.map((s) => (
                      <PoolRow key={s.code} stock={s} included={included.has(s.code)} groups={groups} onToggle={toggleInclude} onSetGroup={setStockGroup} onRemove={removeFromPool} />
                    ))}
                  </React.Fragment>
                ))
              )}
            </div>
          </div>

          <div style={{ marginTop: "14px", display: "grid", gap: "12px" }}>
            <SubToggle title="邮件订阅" summary={`${includedCount} 只 · 18:00`}>
              <form className="subscription-panel" onSubmit={(e) => e.preventDefault()}>
                <label>接收邮箱<input type="email" placeholder="name@example.com" /></label>
                <label>每天推送时间<input type="time" defaultValue="18:00" /></label>
                <div className="hint alert-hint">已自动选用股票池中勾选的 <strong>{includedCount}</strong> 只股票，无需在此重复维护列表。</div>
                <button type="submit">订阅每日邮件</button>
              </form>
            </SubToggle>
            <SubToggle title="预警订阅" summary={`${includedCount} 只 · ±2σ`}>
              <form className="subscription-panel alert-panel" onSubmit={(e) => e.preventDefault()}>
                <label>预警邮箱<input type="email" placeholder="name@example.com" /></label>
                <div className="date-grid">
                  <label>轨道倍数<select defaultValue="2"><option value="1">±1σ</option><option value="2">±2σ</option><option value="3">±3σ</option></select></label>
                  <label>触发条件<select defaultValue="outside"><option value="outside">高于上轨或低于下轨</option><option value="above">高于上轨</option><option value="below">低于下轨</option></select></label>
                </div>
                <div className="hint alert-hint">监控股票池中勾选的 <strong>{includedCount}</strong> 只股票。</div>
                <button type="submit">订阅预警邮件</button>
              </form>
            </SubToggle>
          </div>
        </aside>

        {/* ── 主区：股票池总览 ── */}
        <section className="content">
          <header className="overview-head">
            <div>
              <p className="eyebrow">股票池总览</p>
              <h2>我的股票池</h2>
              <span>共 {pool.length} 只 · 已勾选 {includedCount} 只纳入订阅与预警 · 点击卡片可切换</span>
            </div>
            <div className="overview-filters">
              <div className="view-switch">
                {[["ALL", "全部"], ["A", "A股"], ["HK", "港股"], ["US", "美股"]].map(([k, label]) => (
                  <button key={k} type="button" className={ovMarket === k ? "vs-btn active" : "vs-btn"} onClick={() => setOvMarket(k)}>{label}</button>
                ))}
              </div>
              <button type="button" className="btn-import" onClick={() => setImportOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                批量导入
              </button>
            </div>
          </header>

          <section className="table-panel" style={{ padding: "18px" }}>
            {ovStocks.length === 0 ? (
              <div className="pf-empty">该市场暂无股票</div>
            ) : (
              <div className="pf-cards">
                {ovStocks.map((s) => (
                  <StockCard key={s.code} stock={s} included={included.has(s.code)} groupName={groupName(s.groupId)} onToggle={toggleInclude} />
                ))}
              </div>
            )}
          </section>
        </section>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
