/* ============================================================
   批量导入弹窗 + 共享小组件（babel / JSX）
   依赖 window.PoolData。导出到 window 供 pool-app.jsx 使用。
   ============================================================ */
const { useState, useRef, useMemo, useEffect } = React;
const PD = window.PoolData;

/* —— 市场标识小徽标 —— */
function MarketBadge({ code, market, showSub = true }) {
  const cat = market || PD.marketCategory(code);
  const dot = PD.MARKET_DOT[cat] || "mk-none";
  let label = PD.MARKET_SHORT[cat] || "未知";
  if (showSub && cat === "A") {
    const sub = PD.marketSub(code);
    if (sub) label = `${sub} · A股`;
  }
  return (
    <span className="mk-badge">
      <span className={`mk-dot ${dot}`}></span>
      {label}
    </span>
  );
}

/* —— 单个已解析代码 chip —— */
function CodeChip({ item, editing, editValue, onEditChange, onStartEdit, onCommitEdit, onRemove }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  if (item.status === "invalid") {
    return (
      <span className="code-chip invalid" onClick={() => !editing && onStartEdit(item.id)}>
        {editing ? (
          <input
            ref={inputRef}
            className="cc-edit"
            value={editValue}
            onChange={(e) => onEditChange(PD.cleanSecurityInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitEdit(item.id);
              if (e.key === "Escape") onCommitEdit(item.id);
            }}
            onBlur={() => onCommitEdit(item.id)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="cc-warn-ico">⚠</span>
            <span>{item.raw || "?"}</span>
          </>
        )}
        <button type="button" className="cc-x" title="移除" onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}>×</button>
      </span>
    );
  }

  return (
    <span className={`code-chip ${item.status}`}>
      <span className={`mk-dot ${PD.MARKET_DOT[item.market] || "mk-none"}`}></span>
      <span>{item.code}</span>
      {item.name ? (
        <span className="cc-name">{item.name}</span>
      ) : item.status === "ok" ? (
        <span className="cc-name">名称待获取</span>
      ) : null}
      {item.status === "duplicate" && (
        <span className="cc-name" style={{ opacity: 0.85 }}>{item.dupOf === "pool" ? "已在池" : "重复"}</span>
      )}
      <button type="button" className="cc-x" title="移除" onClick={() => onRemove(item.id)}>×</button>
    </span>
  );
}

const SAMPLE = "600519, 000858 600276\n00700 09988\nAAPL NVDA AMD\n688256 12345678";

function ImportModal({ open, onClose, poolCodes, groups, onImport }) {
  const [mode, setMode] = useState("paste");
  const [chips, setChips] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [groupChoice, setGroupChoice] = useState("__none__");
  const [newGroupName, setNewGroupName] = useState("");
  const [autoInclude, setAutoInclude] = useState(true);
  const [fileName, setFileName] = useState("");
  const inputRef = useRef(null);
  const fileRef = useRef(null);

  const poolSet = useMemo(() => new Set(poolCodes), [poolCodes]);
  const parsed = useMemo(() => PD.parseChips(chips, poolSet), [chips, poolSet]);

  const counts = useMemo(() => {
    let ok = 0, dup = 0, bad = 0;
    parsed.forEach((p) => {
      if (p.status === "ok") ok += 1;
      else if (p.status === "duplicate") dup += 1;
      else bad += 1;
    });
    return { ok, dup, bad };
  }, [parsed]);

  // reset when closed
  useEffect(() => {
    if (!open) {
      setChips([]); setInputValue(""); setEditingId(null); setEditValue("");
      setGroupChoice("__none__"); setNewGroupName(""); setMode("paste"); setFileName("");
    }
  }, [open]);

  // esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && editingId == null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editingId, onClose]);

  if (!open) return null;

  function addRaws(raws) {
    const fresh = raws.map((raw) => ({ id: PD.uid("chip"), raw }));
    if (fresh.length) setChips((cur) => [...cur, ...fresh]);
  }

  function handleInputChange(v) {
    if (/[\s,;，；、|]/.test(v)) {
      const segs = v.split(/[\s,;，；、|]+/);
      const trailing = segs.pop();
      addRaws(segs.filter(Boolean));
      setInputValue(trailing);
    } else {
      setInputValue(v);
    }
  }

  function handlePaste(e) {
    const text = e.clipboardData.getData("text");
    if (text && /[\s,;，；、|]/.test(text)) {
      e.preventDefault();
      const toks = PD.tokenize(text);
      addRaws(toks);
      setInputValue("");
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputValue.trim()) { addRaws([inputValue.trim()]); setInputValue(""); }
    } else if (e.key === "Backspace" && inputValue === "" && chips.length) {
      setChips((cur) => cur.slice(0, -1));
    }
  }

  function removeChip(id) {
    setChips((cur) => cur.filter((c) => c.id !== id));
  }

  function startEdit(id) {
    const chip = chips.find((c) => c.id === id);
    setEditingId(id);
    setEditValue(chip ? chip.raw : "");
  }

  function commitEdit(id) {
    const val = editValue.trim();
    setChips((cur) => {
      if (!val) return cur.filter((c) => c.id !== id);
      const toks = PD.tokenize(val);
      if (toks.length <= 1) return cur.map((c) => (c.id === id ? { ...c, raw: val } : c));
      // multiple tokens entered → expand
      const out = [];
      cur.forEach((c) => {
        if (c.id === id) toks.forEach((t) => out.push({ id: PD.uid("chip"), raw: t }));
        else out.push(c);
      });
      return out;
    });
    setEditingId(null);
    setEditValue("");
  }

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      addRaws(PD.tokenize(String(reader.result || "")));
    };
    reader.readAsText(file);
  }

  function clearAll() {
    setChips([]); setInputValue(""); setFileName("");
  }

  function doImport() {
    const items = parsed
      .filter((p) => p.status === "ok")
      .map((p) => ({ code: p.code, name: p.name, market: p.market }));
    if (!items.length) return;
    onImport({ items, groupChoice, newGroupName: newGroupName.trim(), autoInclude });
  }

  const importDisabled = counts.ok === 0 || (groupChoice === "__new__" && !newGroupName.trim());

  return (
    <div className="import-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="import-modal" role="dialog" aria-modal="true">
        <div className="import-head">
          <div>
            <h3>批量导入股票</h3>
            <p>粘贴一串代码或上传文件，系统自动识别市场与名称、去重，并可整批归入一个分组。</p>
          </div>
          <button type="button" className="import-close" onClick={onClose} title="关闭 (ESC)">×</button>
        </div>

        <div className="import-body">
          <div className="seg">
            <button type="button" className={mode === "paste" ? "seg-btn active" : "seg-btn"} onClick={() => setMode("paste")}>粘贴代码</button>
            <button type="button" className={mode === "file" ? "seg-btn active" : "seg-btn"} onClick={() => setMode("file")}>上传文件</button>
          </div>

          {mode === "paste" ? (
            <>
              <div
                className={focused ? "tag-field focused" : "tag-field"}
                onClick={() => inputRef.current && inputRef.current.focus()}
              >
                {parsed.map((item) => (
                  <CodeChip
                    key={item.id}
                    item={item}
                    editing={editingId === item.id}
                    editValue={editValue}
                    onEditChange={setEditValue}
                    onStartEdit={startEdit}
                    onCommitEdit={commitEdit}
                    onRemove={removeChip}
                  />
                ))}
                {chips.length === 0 && inputValue === "" && (
                  <span className="ghost">粘贴或输入代码，用逗号 / 空格 / 换行分隔…</span>
                )}
                <input
                  ref={inputRef}
                  className="tag-input"
                  value={inputValue}
                  inputMode="text"
                  onChange={(e) => handleInputChange(e.target.value.toUpperCase())}
                  onPaste={handlePaste}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                />
              </div>
              <p className="example-line">
                支持 A股6位 / 港股1–5位 / 美股代码混合，例如 <code>688256 600519 00700 AAPL</code>。
                {chips.length === 0 && <span className="fill" onClick={() => addRaws(PD.tokenize(SAMPLE))}>　填入示例</span>}
              </p>
            </>
          ) : (
            <>
              <div
                className={dragOver ? "drop-zone drag" : "drop-zone"}
                onClick={() => fileRef.current && fileRef.current.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files[0]); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <strong>{fileName ? `已读取：${fileName}` : "拖拽 CSV / TXT 文件到这里"}</strong>
                <span>或 <span className="browse">点击选择文件</span>　·　逐行或逗号分隔的代码均可</span>
                <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: "none" }} onChange={(e) => readFile(e.target.files[0])} />
              </div>
              {chips.length > 0 && (
                <div className={"tag-field"} style={{ minHeight: "auto" }}>
                  {parsed.map((item) => (
                    <CodeChip key={item.id} item={item} editing={editingId === item.id} editValue={editValue} onEditChange={setEditValue} onStartEdit={startEdit} onCommitEdit={commitEdit} onRemove={removeChip} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* live summary */}
          {chips.length > 0 && (
            <div className="import-summary">
              <div className="sum-cell sum-ok"><b>{counts.ok}</b><span>可识别 · 将导入</span></div>
              <div className="sum-cell sum-dup"><b>{counts.dup}</b><span>重复 · 自动跳过</span></div>
              <div className="sum-cell sum-bad"><b>{counts.bad}</b><span>无法识别 · 点击修正</span></div>
            </div>
          )}

          {/* options: group + auto include */}
          <div className="import-opts">
            <div className="opt-line">
              <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink-2)" }}>导入到分组</span>
              <div className="group-pick">
                <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)}>
                  <option value="__none__">不分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                  <option value="__new__">+ 新建分组…</option>
                </select>
                {groupChoice === "__new__" && (
                  <input value={newGroupName} placeholder="新分组名称" maxLength="12" onChange={(e) => setNewGroupName(e.target.value)} />
                )}
              </div>
            </div>
            <div className="opt-line">
              <label htmlFor="auto-inc">导入后自动勾选「纳入订阅 / 预警」</label>
              <span className="toggle">
                <input id="auto-inc" type="checkbox" checked={autoInclude} onChange={(e) => setAutoInclude(e.target.checked)} />
                <span className="track"></span>
              </span>
            </div>
          </div>
        </div>

        <div className="import-foot">
          <div className="foot-note">
            {chips.length > 0
              ? <>将导入 <strong>{counts.ok}</strong> 只 · 跳过 <strong>{counts.dup}</strong> 重复{counts.bad > 0 && <> · <strong>{counts.bad}</strong> 待修正</>}</>
              : "尚未输入代码"}
          </div>
          <div className="foot-actions">
            {chips.length > 0 && <button type="button" className="secondary-action" onClick={clearAll}>清空</button>}
            <button type="button" className="secondary-action" onClick={onClose}>取消</button>
            <button type="button" onClick={doImport} disabled={importDisabled}>导入 {counts.ok > 0 ? counts.ok + " 只" : ""}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ImportModal, MarketBadge, CodeChip });
