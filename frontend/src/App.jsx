import React, { useState, useEffect, useRef, useCallback } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

// Set by the App component so that ANY API call — not just the initial bootstrap — can
// trigger a clean logout when the backend reports an expired/invalid token. Without this,
// a token expiring mid-session (e.g. while running a query) left the user stuck on a broken
// page with no way back to the login screen.
let handleUnauthorized = null;

async function api(path, options = {}) {
  const token = localStorage.getItem("nlq_token");
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!(options.body instanceof FormData) && options.body !== undefined) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    handleUnauthorized?.();
    throw new Error(data.message || "Your session has expired. Please sign in again.");
  }
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}

// Query results can mix real JS numbers with numeric-looking strings (e.g. from COUNT/SUM
// under edge cases, or values re-serialized through JSON). This treats both as numeric so
// chart/column auto-detection doesn't silently break depending on the exact wire format.
function isNumericVal(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return !Number.isNaN(Number(v));
  return false;
}
function numVal(v) { return Number(v) || 0; }

function exportCSV(rows, filename = "export.csv") {
  if (!rows?.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => { const v = String(r[h] ?? ""); return v.includes(",") || v.includes('"') || v.includes("\n") ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function exportJSON(rows, filename = "export.json") {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const ROLE_PERMISSIONS = {
  dashboard:["admin","manager","analyst","viewer"], analytics:["admin","manager","analyst","viewer"],
  query:["admin","manager","analyst"], builder:["analyst","admin"], upload:["admin"], users:["admin"], requests:["admin","manager","analyst"],
  savedQueries:["admin","manager","analyst"], auditLogs:["admin"], datasetExplorer:["admin","manager","analyst"]
};

// ─── CHART COMPONENTS ─────────────────────────────────────────────────────────
function KPI({ label, value, color = "#6366f1" }) {
  return (
    <div style={{ background: "#0d0d1a", border: "1px solid #13132a", borderRadius: "12px", padding: "20px", borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: "11px", color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>{label}</div>
      <div style={{ fontSize: "28px", fontWeight: 800, color: "#e2e8f0", fontFamily: "'Syne',sans-serif" }}>{typeof value === 'number' ? value.toLocaleString() : value ?? '—'}</div>
    </div>
  );
}

function BarChart({ data, xKey, yKey, color = "#6366f1" }) {
  if (!data?.length) return <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>No data</div>;
  const max = Math.max(...data.map(d => numVal(d[yKey])));
  return (
    <div style={{ padding: "16px 8px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "6px", height: "160px", borderBottom: "1px solid #2a2a3e" }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", height: "100%", justifyContent: "flex-end" }}>
            <div style={{ fontSize: "9px", color: "#888", fontFamily: "'JetBrains Mono',monospace" }}>{numVal(d[yKey]).toLocaleString()}</div>
            <div style={{ width: "100%", background: `linear-gradient(180deg, ${color}, ${color}88)`, borderRadius: "3px 3px 0 0", height: `${max ? (numVal(d[yKey]) / max) * 120 : 0}px`, minHeight: "2px", transition: "height 0.5s ease" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, textAlign: "center", fontSize: "9px", color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d[xKey]).slice(0, 10)}</div>
        ))}
      </div>
    </div>
  );
}

function LineChart({ data, xKey, yKey, color = "#22d3ee" }) {
  if (!data?.length) return <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>No data</div>;
  const vals = data.map(d => numVal(d[yKey]));
  const max = Math.max(...vals), min = Math.min(...vals);
  const range = max - min || 1;
  const W = 400, H = 120, pad = 20;
  const pts = vals.map((v, i) => `${pad + (i / (vals.length - 1 || 1)) * (W - 2 * pad)},${H - pad - ((v - min) / range) * (H - 2 * pad)}`).join(" ");
  return (
    <div style={{ padding: "8px" }}>
      <svg viewBox={`0 0 ${W} ${H + 30}`} style={{ width: "100%" }}>
        <defs><linearGradient id={`lg-${yKey}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.3" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#2a2a3e" strokeWidth="1" />
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#2a2a3e" strokeWidth="1" />
        {pts && <polygon points={`${pad},${H - pad} ${pts} ${W - pad},${H - pad}`} fill={`url(#lg-${yKey})`} />}
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
        {vals.map((v, i) => (
          <circle key={i} cx={pad + (i / (vals.length - 1 || 1)) * (W - 2 * pad)} cy={H - pad - ((v - min) / range) * (H - 2 * pad)} r="3" fill={color} />
        ))}
        {data.map((d, i) => (
          <text key={i} x={pad + (i / (vals.length - 1 || 1)) * (W - 2 * pad)} y={H + 20} textAnchor="middle" fill="#888" fontSize="9" fontFamily="'JetBrains Mono',monospace">{String(d[xKey]).slice(0, 8)}</text>
        ))}
      </svg>
    </div>
  );
}

function AreaChart({ data, xKey, yKey, color = "#10b981" }) {
  if (!data?.length) return <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>No data</div>;
  const vals = data.map(d => numVal(d[yKey]));
  const max = Math.max(...vals), min = 0;
  const range = max || 1;
  const W = 400, H = 120, pad = 20;
  const pts = vals.map((v, i) => `${pad + (i / (vals.length - 1 || 1)) * (W - 2 * pad)},${H - pad - ((v - min) / range) * (H - 2 * pad)}`).join(" ");
  return (
    <div style={{ padding: "8px" }}>
      <svg viewBox={`0 0 ${W} ${H + 30}`} style={{ width: "100%" }}>
        <defs><linearGradient id={`ag-${yKey}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.4" /><stop offset="100%" stopColor={color} stopOpacity="0.05" /></linearGradient></defs>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#2a2a3e" strokeWidth="1" />
        {pts && <polygon points={`${pad},${H - pad} ${pts} ${W - pad},${H - pad}`} fill={`url(#ag-${yKey})`} />}
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
        {data.map((d, i) => (
          <text key={i} x={pad + (i / (vals.length - 1 || 1)) * (W - 2 * pad)} y={H + 20} textAnchor="middle" fill="#888" fontSize="9" fontFamily="'JetBrains Mono',monospace">{String(d[xKey]).slice(0, 8)}</text>
        ))}
      </svg>
    </div>
  );
}

function PieChart({ data, labelKey, valueKey }) {
  if (!data?.length) return <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>No data</div>;
  const COLORS = ["#6366f1", "#22d3ee", "#f59e0b", "#10b981", "#f43f5e", "#8b5cf6", "#ec4899"];
  const total = data.reduce((s, d) => s + numVal(d[valueKey]), 0);
  if (!total) return <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>No data</div>;
  let startAngle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const val = numVal(d[valueKey]), angle = (val / total) * 2 * Math.PI;
    const x1 = 80 + 70 * Math.cos(startAngle), y1 = 80 + 70 * Math.sin(startAngle);
    startAngle += angle;
    const x2 = 80 + 70 * Math.cos(startAngle), y2 = 80 + 70 * Math.sin(startAngle);
    const large = angle > Math.PI ? 1 : 0;
    return { path: `M 80 80 L ${x1} ${y1} A 70 70 0 ${large} 1 ${x2} ${y2} Z`, color: COLORS[i % COLORS.length], label: d[labelKey], val };
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "24px", padding: "16px" }}>
      <svg viewBox="0 0 160 160" style={{ width: "160px", flexShrink: 0 }}>
        {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="#0f0f1a" strokeWidth="1" />)}
      </svg>
      <div style={{ flex: 1 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <div style={{ width: "10px", height: "10px", borderRadius: "2px", background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: "11px", color: "#ccc", flex: 1 }}>{s.label}</span>
            <span style={{ fontSize: "11px", color: "#888", fontFamily: "'JetBrains Mono',monospace" }}>{((s.val / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataTable({ data, maxRows }) {
  if (!data?.length) return <div style={{ color: "#475569", textAlign: "center", padding: "32px", fontSize: "13px" }}>No results found</div>;
  const display = maxRows ? data.slice(0, maxRows) : data;
  const cols = Object.keys(display[0]);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", fontFamily: "'JetBrains Mono',monospace" }}>
        <thead>
          <tr>{cols.map(c => <th key={c} style={styles.th}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {display.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #0f0f1a" }}
              onMouseEnter={e => e.currentTarget.style.background = "#0a0a14"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {cols.map(c => <td key={c} style={styles.td}>{String(row[c] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {maxRows && data.length > maxRows && <div style={{ fontSize: "11px", color: "#475569", textAlign: "center", padding: "8px" }}>Showing {maxRows} of {data.length} rows</div>}
    </div>
  );
}

// Charts built in the Dashboard Builder often plot raw dataset columns (e.g. "product" vs
// "revenue") where the category repeats across many rows. Plotting that directly produces
// a meaningless bar/line/pie with duplicate, unsorted categories. When the key column has
// repeats, aggregate (sum) by that key first — a no-op when the data is already one row
// per category (e.g. results from the query engine's own GROUP BY).
function aggregateForChart(data, keyField, valField) {
  if (!data?.length || !keyField) return data;
  const seen = new Set();
  let hasDupes = false;
  for (const d of data) {
    const k = d[keyField];
    if (seen.has(k)) { hasDupes = true; break; }
    seen.add(k);
  }
  if (!hasDupes) return data;
  const groups = new Map();
  for (const d of data) {
    const k = d[keyField];
    const prev = groups.get(k) || { [keyField]: k, [valField]: 0 };
    prev[valField] = numVal(prev[valField]) + (valField ? numVal(d[valField]) : 1);
    groups.set(k, prev);
  }
  return [...groups.values()];
}

function renderChart(chart, data, idx) {
  if (!data?.length) return <div style={{ color: "#475569", textAlign: "center", padding: "24px", fontSize: "12px" }}>No data available</div>;
  if (chart.type === "bar") return <BarChart data={aggregateForChart(data, chart.xKey, chart.yKey)} xKey={chart.xKey} yKey={chart.yKey} />;
  if (chart.type === "line") return <LineChart data={aggregateForChart(data, chart.xKey, chart.yKey)} xKey={chart.xKey} yKey={chart.yKey} />;
  if (chart.type === "pie") return <PieChart data={aggregateForChart(data, chart.labelKey, chart.valueKey)} labelKey={chart.labelKey} valueKey={chart.valueKey} />;
  if (chart.type === "area") return <AreaChart data={aggregateForChart(data, chart.xKey, chart.yKey)} xKey={chart.xKey} yKey={chart.yKey} />;
  if (chart.type === "table") return <DataTable data={data} maxRows={5} />;
  if (chart.type === "kpi") {
    if (chart.aggregation === "sum" || chart.aggregation === "avg" || chart.aggregation === "count") {
      const field = chart.metric || chart.yKey || chart.xKey;
      if (chart.aggregation === "count") return <KPI label={chart.title} value={data.length} />;
      const vals = data.map(r => numVal(r[field]));
      const value = chart.aggregation === "sum" ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      return <KPI label={chart.title} value={Math.round(value * 100) / 100} />;
    }
    let display = data[0] ? (data[0][chart.yKey] ?? data[0][chart.xKey] ?? 0) : 0;
    return <KPI label={chart.title} value={display} />;
  }
  return <DataTable data={data} maxRows={5} />;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function NLQueryEngine() {
  const [currentUser, setCurrentUser] = useState(() => { try { return JSON.parse(localStorage.getItem("nlq_user")); } catch { return null; } });
  const [page, setPage] = useState("dashboard");
  const [users, setUsers] = useState([]);
  const [datasets, setDatasets] = useState({});
  const [datasetRequests, setDatasetRequests] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [queryHistory, setQueryHistory] = useState([]);
  const [savedQueries, setSavedQueries] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [notification, setNotification] = useState(null);

  const showNotif = (msg, type = "success") => { setNotification({ msg, type }); setTimeout(() => setNotification(null), 3500); };

  const loadApp = useCallback(async () => {
    if (!localStorage.getItem("nlq_token")) return;
    try {
      const data = await api("/bootstrap");
      setDatasets(data.datasets || {});
      setUsers(data.users || []);
      setDatasetRequests(data.requests || []);
      setDashboards(data.dashboards || []);
      setQueryHistory((data.queryHistory || []).map(q => ({ ...q, query: q.query ?? q.query_text, sql: q.sql ?? q.sql_text, rows: q.rows ?? q.row_count })));
      setSavedQueries(data.savedQueries || []);
    } catch (e) {
      if (/authentication|invalid|expired/i.test(e.message)) { localStorage.removeItem("nlq_token"); localStorage.removeItem("nlq_user"); setCurrentUser(null); }
      showNotif(e.message || "Could not load application data", "error");
    }
  }, []);

  useEffect(() => { if (currentUser) loadApp(); }, [currentUser, loadApp]);

  const logout = () => { localStorage.removeItem("nlq_token"); localStorage.removeItem("nlq_user"); setCurrentUser(null); setPage("dashboard"); };

  // Wire the module-level 401 hook to a real logout so ANY api() call — not just bootstrap —
  // cleanly signs the user out and returns them to the login screen when their token expires.
  useEffect(() => {
    handleUnauthorized = () => {
      localStorage.removeItem("nlq_token"); localStorage.removeItem("nlq_user");
      setCurrentUser(null); setPage("dashboard");
      showNotif("Your session has expired. Please sign in again.", "warning");
    };
    return () => { handleUnauthorized = null; };
  }, []);

  const login = async (email, password) => {
    try {
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem("nlq_token", data.token);
      localStorage.setItem("nlq_user", JSON.stringify(data.user));
      setCurrentUser(data.user);
      setPage("dashboard");
      return true;
    } catch { return false; }
  };

  const canAccess = (pg) => !!currentUser && (ROLE_PERMISSIONS[pg] || ROLE_PERMISSIONS.dashboard).includes(currentUser.role);

  if (!currentUser) return <div style={styles.root}><LoginPage login={login} /></div>;

  const pages = {
    dashboard: <DashboardPage user={currentUser} datasets={datasets} dashboards={dashboards} queryHistory={queryHistory} setPage={setPage} requests={datasetRequests} />,
    query: canAccess("query") ? <QueryPage datasets={datasets} user={currentUser} queryHistory={queryHistory} setQueryHistory={setQueryHistory} showNotif={showNotif} savedQueries={savedQueries} setSavedQueries={setSavedQueries} setDashboards={setDashboards} dashboards={dashboards} /> : <NoAccess />,
    analytics: <AnalyticsPage dashboards={dashboards} datasets={datasets} user={currentUser} setPage={setPage} />,
    builder: canAccess("builder") ? <DashboardBuilder datasets={datasets} user={currentUser} dashboards={dashboards} setDashboards={setDashboards} showNotif={showNotif} users={users} setPage={setPage} /> : <NoAccess />,
    upload: canAccess("upload") ? <UploadPage datasets={datasets} setDatasets={setDatasets} showNotif={showNotif} reload={loadApp} /> : <NoAccess />,
    explorer: canAccess("datasetExplorer") ? <DatasetExplorerPage datasets={datasets} showNotif={showNotif} /> : <NoAccess />,
    savedQueries: canAccess("savedQueries") ? <SavedQueriesPage savedQueries={savedQueries} setSavedQueries={setSavedQueries} datasets={datasets} showNotif={showNotif} setPage={setPage} /> : <NoAccess />,
    users: canAccess("users") ? <UserManagementPage users={users} setUsers={setUsers} showNotif={showNotif} /> : <NoAccess />,
    requests: canAccess("requests") ? <RequestsPage requests={datasetRequests} setRequests={setDatasetRequests} user={currentUser} showNotif={showNotif} /> : <NoAccess />,
    auditLogs: canAccess("auditLogs") ? <AuditLogsPage showNotif={showNotif} /> : <NoAccess />,
  };

  return (
    <div style={styles.root}>
      {notification && <div style={{ ...styles.notif, background: notification.type === "error" ? "#7f1d1d" : notification.type === "warning" ? "#78350f" : "#064e3b", borderColor: notification.type === "error" ? "#ef4444" : notification.type === "warning" ? "#f59e0b" : "#10b981" }}>{notification.type === "error" ? "⚠ " : notification.type === "warning" ? "⚠ " : "✓ "}{notification.msg}</div>}
      <Sidebar user={currentUser} page={page} setPage={setPage} logout={logout} canAccess={canAccess} />
      <main style={styles.main}><Header user={currentUser} page={page} /><div style={styles.content}>{pages[page] || pages.dashboard}</div></main>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ user, page, setPage, logout, canAccess }) {
  const navItems = [
    { id: "dashboard", icon: "⬡", label: "Dashboard" },
    { id: "query", icon: "◈", label: "Query Engine", roles: ["admin", "manager", "analyst"] },
    { id: "analytics", icon: "◉", label: "Analytics" },
    { id: "explorer", icon: "◇", label: "Dataset Explorer", roles: ["admin", "manager", "analyst"] },
    { id: "builder", icon: "⬟", label: "Dashboard Builder", roles: ["analyst", "admin"] },
    { id: "upload", icon: "⬆", label: "Upload Dataset", roles: ["admin"] },
    { id: "savedQueries", icon: "❖", label: "Saved Queries", roles: ["admin", "manager", "analyst"] },
    { id: "requests", icon: "◎", label: "Requests" },
    { id: "users", icon: "⊞", label: "User Management", roles: ["admin"] },
    { id: "auditLogs", icon: "☰", label: "Audit Logs", roles: ["admin"] },
  ];
  return (
    <aside style={styles.sidebar}>
      <div style={styles.logo}>
        <div style={styles.logoIcon}>NQ</div>
        <div><div style={styles.logoText}>NLQuery</div><div style={styles.logoSub}>Engine</div></div>
      </div>
      <div style={styles.userCard}>
        <div style={styles.avatar}>{user.avatar}</div>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "#e2e8f0" }}>{user.name}</div>
          <div style={{ ...styles.roleBadge, ...roleColors[user.role] }}>{user.role}</div>
        </div>
      </div>
      <nav style={{ flex: 1, overflowY: "auto" }}>
        {navItems.filter(n => !n.roles || canAccess(n.id)).map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{ ...styles.navBtn, ...(page === n.id ? styles.navBtnActive : {}) }}>
            <span style={styles.navIcon}>{n.icon}</span><span>{n.label}</span>
            {page === n.id && <div style={styles.navIndicator} />}
          </button>
        ))}
      </nav>
      <button onClick={logout} style={styles.logoutBtn}><span>⏻</span> Sign Out</button>
    </aside>
  );
}

function Header({ user, page }) {
  const titles = { dashboard: "Overview", query: "Query Engine", analytics: "Analytics", builder: "Dashboard Builder", upload: "Upload Dataset", explorer: "Dataset Explorer", users: "User Management", requests: "Requests", savedQueries: "Saved Queries", auditLogs: "Audit Logs" };
  const subtitles = { query: "Ask questions in plain English — get instant data insights", analytics: "Visual dashboards and performance metrics", builder: "Create and configure analytics dashboards", explorer: "Explore dataset schemas, profiles, and data quality", upload: "Upload CSV files to create new datasets", savedQueries: "Manage your saved queries", auditLogs: "System activity and audit trail" };
  return (
    <header style={styles.header}>
      <div><h1 style={styles.pageTitle}>{titles[page] || "Dashboard"}</h1><p style={styles.pageSubtitle}>{subtitles[page] || "NLQueryEngine — Natural Language Data Platform"}</p></div>
      <div style={styles.headerRight}><div style={styles.statusDot} /><span style={{ fontSize: "12px", color: "#64748b" }}>System Online</span></div>
    </header>
  );
}

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
function LoginPage({ login }) {
  const [email, setEmail] = useState("admin@nlquery.io");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const demoAccounts = [
    { label: "Admin", email: "admin@nlquery.io", password: "admin123", color: "#6366f1" },
    { label: "Manager", email: "manager@nlquery.io", password: "mgr123", color: "#22d3ee" },
    { label: "Analyst", email: "analyst@nlquery.io", password: "ana123", color: "#10b981" },
    { label: "Viewer", email: "viewer@nlquery.io", password: "view123", color: "#f59e0b" },
  ];
  const handleSubmit = async () => { setLoading(true); setError(""); const ok = await login(email, password); if (!ok) setError("Invalid credentials"); setLoading(false); };
  return (
    <div style={loginStyles.root}>
      <div style={loginStyles.bg} /><div style={loginStyles.grid} />
      <div style={loginStyles.card}>
        <div style={loginStyles.logo}><div style={loginStyles.logoMark}>NQ</div></div>
        <h1 style={loginStyles.title}>NLQueryEngine</h1>
        <p style={loginStyles.subtitle}>Natural Language Data Intelligence Platform</p>
        <div style={loginStyles.demoRow}>
          {demoAccounts.map(a => (
            <button key={a.label} onClick={() => { setEmail(a.email); setPassword(a.password); setError(""); }}
              style={{ ...loginStyles.demoBtn, borderColor: email === a.email ? a.color : "#1e1e2e", color: email === a.email ? a.color : "#666" }}>{a.label}</button>
          ))}
        </div>
        {error && <div style={loginStyles.error}>{error}</div>}
        <div style={loginStyles.field}><label style={loginStyles.label}>Email</label><input value={email} onChange={e => setEmail(e.target.value)} style={loginStyles.input} placeholder="email@company.com" /></div>
        <div style={loginStyles.field}><label style={loginStyles.label}>Password</label><input value={password} onChange={e => setPassword(e.target.value)} type="password" style={loginStyles.input} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && handleSubmit()} /></div>
        <button onClick={handleSubmit} disabled={loading} style={loginStyles.btn}>{loading ? "Authenticating..." : "Sign In →"}</button>
        <p style={{ fontSize: "11px", color: "#444", textAlign: "center", marginTop: "16px" }}>Select a demo role above to auto-fill credentials</p>
      </div>
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
function DashboardPage({ user, datasets, dashboards, queryHistory, setPage, requests }) {
  const pendingReqs = requests.filter(r => r.status === "pending").length;
  const totalRows = Object.values(datasets).reduce((s, d) => s + (d.rowCount || d.rows?.length || 0), 0);
  const stats = [
    { label: "Datasets", value: Object.keys(datasets).length, icon: "◈", color: "#6366f1" },
    { label: "Total Rows", value: totalRows, icon: "≡", color: "#22d3ee" },
    { label: "Dashboards", value: dashboards.length, icon: "◉", color: "#10b981" },
    { label: "Queries Run", value: queryHistory.length, icon: "⟡", color: "#f59e0b" },
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "32px" }}>
        {stats.map((s, i) => (
          <div key={i} style={{ ...styles.card, borderTop: `2px solid ${s.color}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div><div style={{ fontSize: "28px", fontWeight: 800, color: "#e2e8f0", fontFamily: "'Syne',sans-serif" }}>{typeof s.value === "number" ? s.value.toLocaleString() : s.value}</div><div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>{s.label}</div></div>
              <div style={{ fontSize: "24px", opacity: 0.6 }}>{s.icon}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "24px" }}>
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Available Datasets</h3>
          {Object.values(datasets).length === 0 ? <div style={{ color: "#475569", fontSize: "13px", padding: "20px 0", textAlign: "center" }}>No datasets available</div> :
            Object.values(datasets).map(ds => (
              <div key={ds.id} style={styles.listItem}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ ...styles.iconBadge, background: "#1e1b4b" }}><span style={{ color: "#6366f1" }}>◈</span></div>
                  <div><div style={{ fontSize: "13px", fontWeight: 600, color: "#e2e8f0" }}>{ds.name}</div><div style={{ fontSize: "11px", color: "#64748b" }}>{(ds.columnCount || ds.columns?.length || 0)} columns · {ds.rowCount || ds.rows?.length || 0} rows</div></div>
                </div>
              </div>
            ))}
        </div>
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Recent Queries</h3>
          {queryHistory.length === 0 ? (
            <div style={{ color: "#374151", fontSize: "13px", padding: "20px 0", textAlign: "center" }}>No queries yet</div>
          ) : queryHistory.slice(0, 5).map((q, i) => (
            <div key={i} style={styles.listItem}>
              <div style={{ fontSize: "12px", color: "#94a3b8", fontFamily: "'JetBrains Mono',monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{q.query}"</div>
              <div style={{ fontSize: "11px", color: "#475569", flexShrink: 0 }}>{q.rows} rows</div>
            </div>
          ))}
        </div>
      </div>
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Quick Actions</h3>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {["admin", "manager", "analyst"].includes(user.role) && <QuickAction icon="◈" label="Run a Query" desc="Natural language data query" color="#6366f1" onClick={() => setPage("query")} />}
          <QuickAction icon="◉" label="View Analytics" desc="Browse dashboards" color="#22d3ee" onClick={() => setPage("analytics")} />
          {["analyst", "admin"].includes(user.role) && <QuickAction icon="⬟" label="Build Dashboard" desc="Create new analytics" color="#10b981" onClick={() => setPage("builder")} />}
          {user.role === "admin" && <QuickAction icon="⬆" label="Upload Dataset" desc="Add new CSV data" color="#f59e0b" onClick={() => setPage("upload")} />}
          {["admin", "manager", "analyst"].includes(user.role) && <QuickAction icon="◇" label="Explore Data" desc="Dataset profiling" color="#8b5cf6" onClick={() => setPage("explorer")} />}
        </div>
      </div>
    </div>
  );
}

function QuickAction({ icon, label, desc, color, onClick }) {
  return (
    <button onClick={onClick} style={{ background: "#0d0d1a", border: "1px solid #1e1e2e", borderRadius: "10px", padding: "16px 20px", cursor: "pointer", textAlign: "left", minWidth: "160px", transition: "all 0.2s" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.transform = "none"; }}>
      <div style={{ fontSize: "20px", marginBottom: "8px", color }}>{icon}</div>
      <div style={{ fontSize: "13px", fontWeight: 600, color: "#e2e8f0", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontSize: "11px", color: "#475569" }}>{desc}</div>
    </button>
  );
}

// ─── QUERY PAGE ───────────────────────────────────────────────────────────────
function QueryPage({ datasets, user, queryHistory, setQueryHistory, showNotif, savedQueries, setSavedQueries, setDashboards, dashboards }) {
  const [query, setQuery] = useState("");
  const [selectedDs, setSelectedDs] = useState(Object.keys(datasets)[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [generatedSQL, setGeneratedSQL] = useState("");
  const [showSQL, setShowSQL] = useState(false);
  const [vizType, setVizType] = useState("table");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showDashModal, setShowDashModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [selectedDash, setSelectedDash] = useState("");
  const [newDashTitle, setNewDashTitle] = useState("");
  const [useNewDash, setUseNewDash] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    const first = Object.keys(datasets)[0];
    if (!selectedDs && first) setSelectedDs(first);
    if (selectedDs && !datasets[selectedDs] && first) setSelectedDs(first);
  }, [datasets, selectedDs]);

  const examples = ["Show top 5 customers by lifetime value", "Show customers from California", "Orders with amount greater than 1000", "Show all completed orders", "Top 3 products by revenue", "What's the average order amount?", "Show sum of revenue", "Count all records"];

  const runQuery = async () => {
    if (!query.trim()) return;
    setLoading(true); setResult(null);
    try {
      const data = await api("/query", { method: "POST", body: JSON.stringify({ query, dataset: selectedDs }) });
      setGeneratedSQL(data.sql);
      setResult({ rows: data.rows, explanation: data.explanation, rowCount: data.rowCount || data.rows.length });
      setQueryHistory(prev => [{ query, sql: data.sql, rows: data.rows.length, dataset: selectedDs, ts: new Date().toLocaleTimeString() }, ...prev.filter(q => q.query !== query)].slice(0, 20));
      showNotif(`Query returned ${data.rows.length} row${data.rows.length !== 1 ? "s" : ""}`);
    } catch (e) { showNotif("Query failed: " + e.message, "error"); }
    setLoading(false);
  };

  const saveQuery = async () => {
    if (!saveName.trim()) { showNotif("Enter a name", "error"); return; }
    try {
      const data = await api("/saved-queries", { method: "POST", body: JSON.stringify({ name: saveName, naturalQuery: query, dataset: selectedDs, sql: generatedSQL, visualizationType: vizType }) });
      setSavedQueries(prev => [{ id: data.id, name: saveName, natural_query: query, dataset_name: selectedDs, sql_text: generatedSQL, visualization_type: vizType, created_at: new Date().toISOString() }, ...prev]);
      setShowSaveModal(false); setSaveName(""); showNotif("Query saved!");
    } catch (e) { showNotif(e.message, "error"); }
  };

  const addToDashboard = async () => {
    if (!result?.rows?.length) return;
    const chart = vizType === "pie"
      ? { type: "pie", labelKey: Object.keys(result.rows[0])[0], valueKey: Object.keys(result.rows[0]).find(k => isNumericVal(result.rows[0][k])) || Object.keys(result.rows[0])[0], title: query.slice(0, 50) }
      : vizType === "kpi"
        ? { type: "kpi", title: query.slice(0, 50), yKey: Object.keys(result.rows[0])[0], xKey: Object.keys(result.rows[0])[0] }
        : { type: vizType, xKey: Object.keys(result.rows[0])[0], yKey: Object.keys(result.rows[0]).find(k => isNumericVal(result.rows[0][k])) || Object.keys(result.rows[0])[0], title: query.slice(0, 50) };
    try {
      if (useNewDash) {
        if (!newDashTitle.trim()) { showNotif("Enter a dashboard title", "error"); return; }
        const data = await api("/dashboards", { method: "POST", body: JSON.stringify({ title: newDashTitle, description: `Created from query: ${query.slice(0, 100)}`, dataset: selectedDs, charts: [chart], access: [] }) });
        setDashboards(prev => [...prev, { id: data.id, title: newDashTitle, dataset: selectedDs, charts: [chart], createdBy: user.id, access: [] }]);
        showNotif("Dashboard created with chart!");
      } else {
        if (!selectedDash) { showNotif("Select a dashboard", "error"); return; }
        const existing = dashboards.find(d => String(d.id) === String(selectedDash));
        if (!existing) { showNotif("Dashboard not found", "error"); return; }
        const updatedCharts = [...(existing.charts || []), chart];
        await api(`/dashboards/${selectedDash}`, { method: "PUT", body: JSON.stringify({ title: existing.title, description: existing.description || "", dataset: existing.dataset, charts: updatedCharts, access: existing.access || [] }) });
        setDashboards(prev => prev.map(d => d.id === Number(selectedDash) ? { ...d, charts: updatedCharts } : d));
        showNotif("Chart added to dashboard!");
      }
      setShowDashModal(false);
    } catch (e) { showNotif(e.message, "error"); }
  };

  return (
    <div>
      <div style={styles.card}>
        <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "200px" }}>
            <label style={styles.label}>Dataset</label>
            <select value={selectedDs} onChange={e => setSelectedDs(e.target.value)} style={styles.select}>
              {Object.keys(datasets).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div style={{ fontSize: "11px", color: "#475569", alignSelf: "flex-end", paddingBottom: "8px" }}>
            {datasets[selectedDs]?.columns?.join(" · ")}
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <textarea ref={textareaRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) runQuery(); }}
            placeholder="Ask a question in plain English... e.g. 'Show top 10 customers by revenue'"
            style={{ ...styles.textarea, resize: "vertical" }} rows={3} />
          <div style={{ position: "absolute", bottom: "12px", right: "12px", fontSize: "10px", color: "#334155" }}>Ctrl+Enter to run</div>
        </div>
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
          {examples.map((ex, i) => (<button key={i} onClick={() => setQuery(ex)} style={styles.exampleBtn}>{ex}</button>))}
        </div>
        <div style={{ display: "flex", gap: "10px", marginTop: "16px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={runQuery} disabled={loading || !query.trim()} style={{ ...styles.primaryBtn, opacity: loading || !query.trim() ? 0.5 : 1 }}>
            {loading ? <><span style={styles.spinner} /> Processing...</> : "▶ Run Query"}
          </button>
          {generatedSQL && <button onClick={() => setShowSQL(!showSQL)} style={styles.ghostBtn}>{showSQL ? "Hide" : "Show"} SQL</button>}
          {generatedSQL && <button onClick={() => { navigator.clipboard?.writeText(generatedSQL); showNotif("SQL copied to clipboard"); }} style={styles.ghostBtn}>Copy SQL</button>}
          {result && (
            <>
              <select value={vizType} onChange={e => setVizType(e.target.value)} style={{ ...styles.select, width: "auto", padding: "6px 12px" }}>
                <option value="table">Table</option><option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option><option value="area">Area</option><option value="kpi">KPI</option>
              </select>
              <button onClick={() => setShowSaveModal(true)} style={styles.ghostBtn}>Save Query</button>
              <button onClick={() => setShowDashModal(true)} style={styles.ghostBtn}>Add to Dashboard</button>
              <button onClick={() => exportCSV(result.rows, `query-${Date.now()}.csv`)} style={styles.ghostBtn}>Export CSV</button>
              <button onClick={() => exportJSON(result.rows, `query-${Date.now()}.json`)} style={styles.ghostBtn}>Export JSON</button>
            </>
          )}
        </div>
        {showSQL && generatedSQL && (
          <div style={styles.sqlBlock}>
            <div style={{ fontSize: "10px", color: "#6366f1", marginBottom: "6px", letterSpacing: "0.1em" }}>GENERATED SQL</div>
            <code style={{ fontSize: "12px", color: "#22d3ee", fontFamily: "'JetBrains Mono',monospace", wordBreak: "break-all" }}>{generatedSQL}</code>
          </div>
        )}
      </div>

      {result && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={styles.cardTitle}>Results</h3>
            <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "'JetBrains Mono',monospace" }}>{result.rowCount} rows</span>
          </div>
          {result.explanation && <p style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px", fontStyle: "italic" }}>ℹ {result.explanation}</p>}
          <div style={{ marginBottom: "16px" }}>{renderChart({ type: vizType, xKey: result.rows[0] ? Object.keys(result.rows[0])[0] : "", yKey: result.rows[0] ? (Object.keys(result.rows[0]).find(k => isNumericVal(result.rows[0][k])) || Object.keys(result.rows[0])[0]) : "", labelKey: result.rows[0] ? Object.keys(result.rows[0])[0] : "", valueKey: result.rows[0] ? (Object.keys(result.rows[0]).find(k => isNumericVal(result.rows[0][k])) || Object.keys(result.rows[0])[0]) : "", title: query }, result.rows, 0)}</div>
          {vizType === "table" && <DataTable data={result.rows} />}
        </div>
      )}

      {queryHistory.length > 0 && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Query History</h3>
          {queryHistory.slice(0, 10).map((q, i) => (
            <div key={i} style={{ ...styles.listItem, cursor: "pointer" }} onClick={() => { setQuery(q.query); setSelectedDs(q.dataset); }}
              onMouseEnter={e => e.currentTarget.style.background = "#0a0a14"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "12px", color: "#94a3b8", fontFamily: "'JetBrains Mono',monospace" }}>"{q.query}"</div>
                <div style={{ fontSize: "11px", color: "#334155", marginTop: "2px" }}>{q.dataset} · {q.rows} rows · {q.ts}</div>
              </div>
              <div style={{ fontSize: "11px", color: "#334155" }}>↩ reuse</div>
            </div>
          ))}
        </div>
      )}

      {showSaveModal && (
        <div style={styles.modalOverlay} onClick={() => setShowSaveModal(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.cardTitle}>Save Query</h3>
            <div style={{ marginBottom: "12px" }}><label style={styles.label}>Query Name</label><input value={saveName} onChange={e => setSaveName(e.target.value)} style={styles.input} placeholder="My saved query" /></div>
            <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "4px" }}>Query: <span style={{ color: "#94a3b8" }}>{query}</span></div>
            <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px" }}>Dataset: <span style={{ color: "#94a3b8" }}>{selectedDs}</span></div>
            <div style={{ display: "flex", gap: "8px" }}><button onClick={saveQuery} style={styles.primaryBtn}>Save</button><button onClick={() => setShowSaveModal(false)} style={styles.ghostBtn}>Cancel</button></div>
          </div>
        </div>
      )}

      {showDashModal && (
        <div style={styles.modalOverlay} onClick={() => setShowDashModal(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.cardTitle}>Add to Dashboard</h3>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <button onClick={() => setUseNewDash(false)} style={{ ...styles.ghostBtn, ...(useNewDash ? {} : { borderColor: "#6366f1", color: "#e2e8f0" }) }}>Existing Dashboard</button>
              <button onClick={() => setUseNewDash(true)} style={{ ...styles.ghostBtn, ...(useNewDash ? { borderColor: "#6366f1", color: "#e2e8f0" } : {}) }}>New Dashboard</button>
            </div>
            {useNewDash ? (
              <div style={{ marginBottom: "12px" }}><label style={styles.label}>Dashboard Title</label><input value={newDashTitle} onChange={e => setNewDashTitle(e.target.value)} style={styles.input} placeholder="My Dashboard" /></div>
            ) : (
              <div style={{ marginBottom: "12px" }}><label style={styles.label}>Select Dashboard</label>
                <select value={selectedDash} onChange={e => setSelectedDash(e.target.value)} style={styles.select}>
                  <option value="">Choose...</option>{dashboards.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
                </select>
              </div>
            )}
            <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px" }}>Chart type: <span style={{ color: "#94a3b8" }}>{vizType}</span></div>
            <div style={{ display: "flex", gap: "8px" }}><button onClick={addToDashboard} style={styles.primaryBtn}>Add Chart</button><button onClick={() => setShowDashModal(false)} style={styles.ghostBtn}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ANALYTICS PAGE ───────────────────────────────────────────────────────────
function AnalyticsPage({ dashboards, datasets, user, setPage }) {
  const [active, setActive] = useState(null);
  const [filters, setFilters] = useState({});

  if (dashboards.length === 0) return (
    <div style={{ ...styles.card, textAlign: "center", padding: "60px" }}>
      <div style={{ fontSize: "48px", marginBottom: "16px", opacity: 0.3 }}>◉</div>
      <h3 style={{ color: "#e2e8f0", marginBottom: "8px" }}>No Analytics Available</h3>
      <p style={{ color: "#475569", fontSize: "13px" }}>{["analyst", "admin"].includes(user.role) ? "Create your first dashboard in the Dashboard Builder." : "No dashboards have been shared with you yet."}</p>
      {["analyst", "admin"].includes(user.role) && <button onClick={() => setPage("builder")} style={{ ...styles.primaryBtn, marginTop: "16px" }}>Create Dashboard</button>}
    </div>
  );

  const current = active ? dashboards.find(d => d.id === active) : null;
  const ds = current ? datasets[current.dataset] : null;

  // Only offer filters for columns that plausibly exist and are meant to be filterable
  // (date / region / state / category / status). Values are derived from the loaded rows
  // so this stays simple and safe — no new SQL surface, per the "don't over-engineer" note.
  const FILTERABLE = ["date", "region", "state", "category", "status"];
  const filterableCols = ds ? (ds.columns || []).filter(c => FILTERABLE.some(f => c.toLowerCase().includes(f))) : [];
  const filteredData = (rows) => {
    if (!rows?.length) return rows;
    return rows.filter(r => filterableCols.every(c => {
      const val = filters[c];
      if (!val) return true;
      if (c.toLowerCase().includes("date")) return String(r[c] || "").startsWith(val);
      return String(r[c] ?? "") === val;
    }));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "16px" }}>
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Dashboards</h3>
        {dashboards.map(d => (
          <button key={d.id} onClick={() => { setActive(d.id); setFilters({}); }}
            style={{ ...styles.navBtn, ...(active === d.id ? styles.navBtnActive : {}), marginBottom: "4px", width: "100%", borderRadius: "8px" }}>
            <span style={{ fontSize: "14px" }}>◉</span>
            <div style={{ flex: 1, textAlign: "left" }}><div style={{ fontSize: "12px", fontWeight: 600 }}>{d.title}</div><div style={{ fontSize: "10px", color: "#475569" }}>{d.charts.length} charts</div></div>
          </button>
        ))}
      </div>
      <div>
        {current ? (
          <div>
            <div style={{ ...styles.card, marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div><h2 style={{ fontSize: "20px", fontWeight: 800, color: "#e2e8f0", fontFamily: "'Syne',sans-serif" }}>{current.title}</h2><p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>{current.description}</p></div>
                <div style={{ fontSize: "11px", color: "#334155", fontFamily: "'JetBrains Mono',monospace" }}>dataset: {current.dataset}</div>
              </div>
              {filterableCols.length > 0 && (
                <div style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap", borderTop: "1px solid #13132a", paddingTop: "14px" }}>
                  {filterableCols.map(c => {
                    const isDate = c.toLowerCase().includes("date");
                    const options = isDate ? [] : [...new Set((ds.rows || []).map(r => r[c]).filter(v => v != null && v !== ""))].sort();
                    return (
                      <div key={c} style={{ minWidth: "140px" }}>
                        <label style={styles.label}>{c}</label>
                        {isDate ? (
                          <input type="text" placeholder="YYYY-MM-DD or YYYY-MM" value={filters[c] || ""} onChange={e => setFilters(p => ({ ...p, [c]: e.target.value }))} style={styles.input} />
                        ) : (
                          <select value={filters[c] || ""} onChange={e => setFilters(p => ({ ...p, [c]: e.target.value }))} style={styles.select}>
                            <option value="">All</option>
                            {options.map(o => <option key={o} value={o}>{String(o)}</option>)}
                          </select>
                        )}
                      </div>
                    );
                  })}
                  {Object.values(filters).some(Boolean) && (
                    <button onClick={() => setFilters({})} style={{ ...styles.ghostBtn, alignSelf: "flex-end" }}>Clear filters</button>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "16px" }}>
              {current.charts.map((chart, i) => {
                const data = filteredData(ds?.rows || []);
                return (
                  <div key={i} style={styles.card}>
                    <h4 style={{ fontSize: "13px", fontWeight: 600, color: "#94a3b8", marginBottom: "8px" }}>{chart.title}</h4>
                    {renderChart(chart, data, i)}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ ...styles.card, textAlign: "center", padding: "60px" }}>
            <div style={{ fontSize: "40px", opacity: 0.2, marginBottom: "12px" }}>◉</div>
            <p style={{ color: "#475569" }}>Select a dashboard to view</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DASHBOARD BUILDER ─────────────────────────────────────────────────────────
function DashboardBuilder({ datasets, user, dashboards, setDashboards, showNotif, users, setPage }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [selectedDs, setSelectedDs] = useState(Object.keys(datasets)[0]);
  const [charts, setCharts] = useState([]);
  const [accessList, setAccessList] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [chartForm, setChartForm] = useState({ type: "bar", xKey: "", yKey: "", labelKey: "", valueKey: "", title: "" });
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState([]);

  useEffect(() => {
    const first = Object.keys(datasets)[0];
    if (!selectedDs && first) setSelectedDs(first);
    if (selectedDs && !datasets[selectedDs] && first) setSelectedDs(first);
  }, [datasets, selectedDs]);

  const ds = datasets[selectedDs];
  const cols = ds?.columns || [];

  const loadTemplates = async () => {
    try { const data = await api("/dashboard-templates"); setTemplates(data.templates || []); setShowTemplates(true); } catch (e) { showNotif(e.message, "error"); }
  };

  const applyTemplate = (t) => {
    setTitle(t.name); setDesc(t.description);
    const mapped = t.charts.map(c => ({ ...c, id: Date.now() + Math.random() }));
    setCharts(mapped); setShowTemplates(false); showNotif(`Template "${t.name}" applied`);
  };

  const addChart = () => { if (!chartForm.title) return; setCharts(prev => [...prev, { ...chartForm, id: Date.now() }]); setChartForm({ type: "bar", xKey: "", yKey: "", labelKey: "", valueKey: "", title: "" }); };
  const removeChart = (id) => setCharts(prev => prev.filter(c => c.id !== id));

  const saveDashboard = async () => {
    if (!title.trim()) { showNotif("Please enter a dashboard title", "error"); return; }
    if (charts.length === 0) { showNotif("Add at least one chart", "error"); return; }
    const payload = { title: title.trim(), description: desc.trim(), dataset: selectedDs, charts: charts.map(({ id, ...rest }) => rest), access: accessList };
    try {
      if (editingId) { await api(`/dashboards/${editingId}`, { method: "PUT", body: JSON.stringify(payload) }); setDashboards(prev => prev.map(d => d.id === editingId ? { ...d, ...payload } : d)); showNotif("Dashboard updated!"); }
      else { const data = await api("/dashboards", { method: "POST", body: JSON.stringify(payload) }); setDashboards(prev => [...prev, { id: data.id, ...payload, createdBy: user.id }]); showNotif("Dashboard created!"); }
      setPage("analytics");
    } catch (e) { showNotif(e.message, "error"); }
  };

  const toggleAccess = (uid) => setAccessList(prev => prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: "16px" }}>
      <div>
        <div style={styles.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ ...styles.cardTitle, marginBottom: 0 }}>Dashboard Info</h3>
            <button onClick={loadTemplates} style={styles.ghostBtn}>Use Template</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div><label style={styles.label}>Title</label><input value={title} onChange={e => setTitle(e.target.value)} style={styles.input} placeholder="Sales Overview" /></div>
            <div><label style={styles.label}>Dataset</label><select value={selectedDs} onChange={e => setSelectedDs(e.target.value)} style={styles.select}>{Object.keys(datasets).map(k => <option key={k} value={k}>{k}</option>)}</select></div>
          </div>
          <div><label style={styles.label}>Description</label><input value={desc} onChange={e => setDesc(e.target.value)} style={styles.input} placeholder="Brief description..." /></div>
        </div>

        {showTemplates && (
          <div style={{ ...styles.card, marginTop: "16px", border: "1px solid #6366f1" }}>
            <h3 style={styles.cardTitle}>Dashboard Templates</h3>
            {templates.map((t, i) => (
              <div key={i} style={{ ...styles.listItem, cursor: "pointer", flexDirection: "column", alignItems: "stretch", gap: "6px" }} onClick={() => applyTemplate(t)}>
                <div style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>{t.name}</div>
                <div style={{ fontSize: "11px", color: "#64748b" }}>{t.description}</div>
                <div style={{ fontSize: "10px", color: "#475569" }}>{t.charts.length} widgets</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Add Chart</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "12px" }}>
            <div><label style={styles.label}>Chart Type</label>
              <select value={chartForm.type} onChange={e => setChartForm(p => ({ ...p, type: e.target.value }))} style={styles.select}>
                <option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option><option value="area">Area</option><option value="kpi">KPI</option><option value="table">Table</option>
              </select>
            </div>
            <div><label style={styles.label}>Chart Title</label><input value={chartForm.title} onChange={e => setChartForm(p => ({ ...p, title: e.target.value }))} style={styles.input} placeholder="Revenue by Product" /></div>
            {chartForm.type === "pie" ? (
              <div><label style={styles.label}>Label Column</label><select value={chartForm.labelKey} onChange={e => setChartForm(p => ({ ...p, labelKey: e.target.value }))} style={styles.select}><option value="">Select...</option>{cols.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            ) : (
              <div><label style={styles.label}>X Axis</label><select value={chartForm.xKey} onChange={e => setChartForm(p => ({ ...p, xKey: e.target.value }))} style={styles.select}><option value="">Select...</option>{cols.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "12px" }}>
            {chartForm.type === "pie" ? (
              <div><label style={styles.label}>Value Column</label><select value={chartForm.valueKey} onChange={e => setChartForm(p => ({ ...p, valueKey: e.target.value }))} style={styles.select}><option value="">Select...</option>{cols.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            ) : (
              <div><label style={styles.label}>Y Axis</label><select value={chartForm.yKey} onChange={e => setChartForm(p => ({ ...p, yKey: e.target.value }))} style={styles.select}><option value="">Select...</option>{cols.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            )}
          </div>
          <button onClick={addChart} style={styles.primaryBtn}>+ Add Chart</button>
        </div>

        {charts.length > 0 && (
          <div style={{ ...styles.card, marginTop: "16px" }}>
            <h3 style={styles.cardTitle}>Charts Preview</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "12px" }}>
              {charts.map((chart, i) => (
                <div key={chart.id || i} style={{ ...styles.card, border: "1px solid #1a1a2e" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <h4 style={{ fontSize: "12px", color: "#94a3b8" }}>{chart.title}</h4>
                    <button onClick={() => removeChart(chart.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "16px" }}>×</button>
                  </div>
                  {renderChart(chart, (ds?.rows || []).slice(0, 6), i)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Access Control</h3>
          <p style={{ fontSize: "12px", color: "#475569", marginBottom: "12px" }}>Select who can view this dashboard</p>
          {users.filter(u => u.id !== user.id && u.role !== "admin").map(u => (
            <div key={u.id} style={{ ...styles.listItem, cursor: "pointer" }} onClick={() => toggleAccess(u.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
                <div style={{ ...styles.avatar, width: "28px", height: "28px", fontSize: "10px" }}>{u.avatar}</div>
                <div><div style={{ fontSize: "12px", color: "#e2e8f0" }}>{u.name}</div><div style={{ fontSize: "10px", color: "#475569" }}>{u.email}</div></div>
              </div>
              <div style={{ width: "16px", height: "16px", border: `2px solid ${accessList.includes(u.id) ? "#6366f1" : "#334155"}`, borderRadius: "3px", background: accessList.includes(u.id) ? "#6366f1" : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {accessList.includes(u.id) && <span style={{ color: "white", fontSize: "10px" }}>✓</span>}
              </div>
            </div>
          ))}
          <div style={{ marginTop: "12px", padding: "10px", background: "#0a0a14", borderRadius: "6px", fontSize: "11px", color: "#475569" }}>{accessList.length} user{accessList.length !== 1 ? "s" : ""} will have access</div>
        </div>
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Summary</h3>
          <div style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.8 }}>
            <div>Title: <span style={{ color: "#94a3b8" }}>{title || "—"}</span></div>
            <div>Dataset: <span style={{ color: "#94a3b8" }}>{selectedDs}</span></div>
            <div>Charts: <span style={{ color: "#94a3b8" }}>{charts.length}</span></div>
            <div>Viewers: <span style={{ color: "#94a3b8" }}>{accessList.length}</span></div>
          </div>
          <button onClick={saveDashboard} style={{ ...styles.primaryBtn, width: "100%", marginTop: "16px" }}>Save Dashboard</button>
        </div>
      </div>
    </div>
  );
}

// ─── DATASET EXPLORER ────────────────────────────────────────────────────────
function DatasetExplorerPage({ datasets, showNotif }) {
  const [selectedDs, setSelectedDs] = useState(Object.keys(datasets)[0] || "");
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("overview");

  const loadProfile = async (dsName) => {
    if (!dsName) return;
    setLoading(true); setProfile(null);
    try {
      const ds = datasets[dsName];
      if (ds?.id) { const data = await api(`/datasets/${ds.id}/profile`); setProfile(data.profile); }
    } catch (e) { showNotif(e.message, "error"); }
    setLoading(false);
  };

  useEffect(() => { if (selectedDs) loadProfile(selectedDs); }, [selectedDs]);

  const ds = datasets[selectedDs];

  return (
    <div>
      <div style={styles.card}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <label style={styles.label}>Select Dataset</label>
            <select value={selectedDs} onChange={e => setSelectedDs(e.target.value)} style={styles.select}>
              {Object.keys(datasets).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: "6px", marginTop: "18px" }}>
            {["overview", "schema", "data", "quality"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ ...styles.ghostBtn, ...(tab === t ? { borderColor: "#6366f1", color: "#e2e8f0" } : {}) }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div style={{ ...styles.card, marginTop: "16px", textAlign: "center", padding: "40px" }}><span style={styles.spinner} /> Loading profile...</div>}

      {!loading && ds && tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "16px", marginTop: "16px" }}>
          <KPI label="Rows" value={ds.rowCount || ds.rows?.length || 0} color="#6366f1" />
          <KPI label="Columns" value={ds.columnCount || ds.columns?.length || 0} color="#22d3ee" />
          <KPI label="Dataset Name" value={ds.name} color="#10b981" />
          <KPI label="Source" value={ds.originalFilename || ".csv"} color="#f59e0b" />
        </div>
      )}

      {!loading && profile && tab === "overview" && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Column Statistics</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead><tr>{["Column", "Type", "Distinct", "Nulls", "Min", "Max", "Avg"].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr></thead>
            <tbody>
              {profile.columns.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #0f0f1a" }}>
                  <td style={{ ...styles.td, color: "#e2e8f0", fontWeight: 600 }}>{c.name}</td>
                  <td style={styles.td}>{c.type}</td>
                  <td style={styles.td}>{c.distinctCount}</td>
                  <td style={styles.td}>{c.nullCount}</td>
                  <td style={styles.td}>{c.min ?? "—"}</td>
                  <td style={styles.td}>{c.max ?? "—"}</td>
                  <td style={styles.td}>{c.avg ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && profile && tab === "schema" && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Schema</h3>
          {profile.columns.map((c, i) => (
            <div key={i} style={{ ...styles.listItem, gap: "16px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "6px", background: c.type === "number" ? "#1e1b4b" : c.type === "date" ? "#052e16" : "#3d1a00", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", color: c.type === "number" ? "#6366f1" : c.type === "date" ? "#10b981" : "#f59e0b", fontWeight: 700, flexShrink: 0 }}>{c.type === "number" ? "#" : c.type === "date" ? "D" : "T"}</div>
              <div style={{ flex: 1 }}><div style={{ fontSize: "13px", color: "#e2e8f0", fontWeight: 600 }}>{c.name}</div><div style={{ fontSize: "11px", color: "#64748b" }}>{c.type} · {c.distinctCount} distinct values</div></div>
              {c.sampleValues?.length > 0 && <div style={{ fontSize: "10px", color: "#475569", fontFamily: "'JetBrains Mono',monospace" }}>Samples: {c.sampleValues.slice(0, 3).join(", ")}</div>}
            </div>
          ))}
        </div>
      )}

      {!loading && ds && tab === "data" && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Sample Data (first 5 rows)</h3>
          <DataTable data={(profile?.sampleRows || ds.rows || []).slice(0, 5)} />
        </div>
      )}

      {!loading && profile && tab === "quality" && (
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h3 style={styles.cardTitle}>Data Quality</h3>
          {profile.columns.map((c, i) => {
            const total = profile.rowCount;
            const nullPct = total ? ((c.nullCount / total) * 100).toFixed(1) : 0;
            const completeness = total ? (((total - c.nullCount) / total) * 100).toFixed(1) : 100;
            return (
              <div key={i} style={{ ...styles.listItem, flexDirection: "column", alignItems: "stretch", gap: "6px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "12px", color: "#e2e8f0", fontWeight: 600 }}>{c.name}</span><span style={{ fontSize: "11px", color: Number(completeness) >= 95 ? "#10b981" : Number(completeness) >= 80 ? "#f59e0b" : "#ef4444" }}>{completeness}% complete</span></div>
                <div style={{ height: "4px", background: "#1e1e2e", borderRadius: "2px" }}><div style={{ height: "100%", width: `${completeness}%`, background: Number(completeness) >= 95 ? "#10b981" : Number(completeness) >= 80 ? "#f59e0b" : "#ef4444", borderRadius: "2px", transition: "width 0.5s" }} /></div>
                <div style={{ fontSize: "10px", color: "#475569" }}>{c.nullCount} null/empty values · {c.distinctCount} distinct</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── UPLOAD PAGE ──────────────────────────────────────────────────────────────
function UploadPage({ datasets, setDatasets, showNotif, reload }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!file || !file.name.toLowerCase().endsWith(".csv")) { showNotif("Only CSV files supported", "error"); return; }
    setUploading(true);
    try {
      const form = new FormData(); form.append("file", file);
      const data = await api("/datasets/preview", { method: "POST", body: form });
      setPreview(data);
    } catch (e) { showNotif(e.message, "error"); }
    setUploading(false);
  };

  const confirmUpload = async () => {
    if (!preview) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", fileRef.current.files[0]);
      const data = await api("/datasets/upload", { method: "POST", body: form });
      setDatasets(prev => ({ ...prev, [data.dataset.name]: data.dataset }));
      setPreview(null); showNotif(data.message);
      await reload?.(); // pick up the dataset in dashboards/query pickers immediately
    } catch (e) { showNotif(e.message, "error"); }
    setUploading(false);
  };

  const deleteDataset = async (ds) => {
    if (!window.confirm(`Delete dataset "${ds.name}"? This cannot be undone.`)) return;
    setDeletingId(ds.id);
    try {
      await api(`/datasets/${ds.id}`, { method: "DELETE" });
      setDatasets(prev => { const next = { ...prev }; delete next[ds.name]; return next; });
      showNotif("Dataset deleted");
      await reload?.();
    } catch (e) { showNotif(e.message, "error"); }
    setDeletingId(null);
  };

  return (
    <div>
      <div style={styles.card}>
        <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
          onClick={() => !uploading && fileRef.current?.click()}
          style={{ border: `2px dashed ${dragging ? "#6366f1" : "#1e1e2e"}`, borderRadius: "12px", padding: "48px", textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: dragging ? "#0d0b1a" : "transparent" }}>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
          <div style={{ fontSize: "32px", marginBottom: "12px", opacity: 0.5 }}>{uploading ? "⟳" : "⬆"}</div>
          <div style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "4px" }}>{uploading ? "Processing dataset..." : "Drop CSV file here or click to browse"}</div>
          <div style={{ fontSize: "12px", color: "#475569" }}>Supports: .csv files (max 25MB)</div>
        </div>
      </div>

      {preview && (
        <div style={{ ...styles.card, marginTop: "16px", border: "1px solid #6366f1" }}>
          <h3 style={styles.cardTitle}>Dataset Preview</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "16px" }}>
            <KPI label="File Name" value={preview.fileName} color="#6366f1" />
            <KPI label="Rows" value={preview.rowCount} color="#22d3ee" />
            <KPI label="Columns" value={preview.columnCount} color="#10b981" />
            <KPI label="Dataset Name" value={preview.datasetName} color="#f59e0b" />
          </div>
          <h4 style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px", letterSpacing: "0.08em", textTransform: "uppercase" }}>Column Details</h4>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "16px" }}>
            <thead><tr>{["Column", "Type", "Nulls"].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr></thead>
            <tbody>
              {(preview.columnDetails || []).map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #0f0f1a" }}>
                  <td style={{ ...styles.td, color: "#e2e8f0" }}>{c.name}</td>
                  <td style={styles.td}>{c.type}</td>
                  <td style={styles.td}>{preview.nullCounts?.[c.name] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px", letterSpacing: "0.08em", textTransform: "uppercase" }}>Sample Rows</h4>
          <DataTable data={preview.sampleRows} maxRows={5} />
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button onClick={confirmUpload} disabled={uploading} style={{ ...styles.primaryBtn, opacity: uploading ? 0.5 : 1 }}>{uploading ? "Uploading..." : "Confirm Upload"}</button>
            <button onClick={() => setPreview(null)} style={styles.ghostBtn}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ ...styles.card, marginTop: "16px" }}>
        <h3 style={styles.cardTitle}>Active Datasets</h3>
        {Object.values(datasets).length === 0 && <div style={{ color: "#475569", textAlign: "center", padding: "20px", fontSize: "13px" }}>No datasets yet. Upload a CSV above to get started.</div>}
        {Object.values(datasets).map(ds => (
          <div key={ds.id} style={styles.listItem}>
            <div style={{ ...styles.iconBadge, background: "#1e1b4b" }}><span style={{ color: "#6366f1" }}>◈</span></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: "13px", fontWeight: 600, color: "#e2e8f0" }}>{ds.name}</div><div style={{ fontSize: "11px", color: "#64748b", fontFamily: "'JetBrains Mono',monospace" }}>{ds.columns?.join(" · ")}</div></div>
            <div style={{ fontSize: "11px", color: "#334155", fontFamily: "'JetBrains Mono',monospace" }}>{ds.rowCount || ds.rows?.length || 0} rows</div>
            <button onClick={() => deleteDataset(ds)} disabled={deletingId === ds.id} style={{ background: "none", border: "1px solid #2a1515", color: "#ef4444", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "11px", marginLeft: "12px", opacity: deletingId === ds.id ? 0.5 : 1 }}>{deletingId === ds.id ? "..." : "Delete"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SAVED QUERIES ────────────────────────────────────────────────────────────
function SavedQueriesPage({ savedQueries, setSavedQueries, datasets, showNotif, setPage }) {
  const deleteQuery = async (id) => {
    try { await api(`/saved-queries/${id}`, { method: "DELETE" }); setSavedQueries(prev => prev.filter(q => q.id !== id)); showNotif("Query deleted"); } catch (e) { showNotif(e.message, "error"); }
  };
  return (
    <div>
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Saved Queries</h3>
        {savedQueries.length === 0 ? <div style={{ color: "#475569", textAlign: "center", padding: "32px", fontSize: "13px" }}>No saved queries yet. Run a query and save it from the Query Engine.</div> :
          savedQueries.map(q => (
            <div key={q.id} style={styles.listItem}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "13px", color: "#e2e8f0", fontWeight: 600 }}>{q.name}</div>
                <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>"{q.natural_query}" · {q.dataset_name || q.dataset} · <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{q.visualization_type || "table"}</span></div>
                <div style={{ fontSize: "10px", color: "#334155", marginTop: "2px", fontFamily: "'JetBrains Mono',monospace" }}>{q.sql_text?.slice(0, 80)}...</div>
              </div>
              <button onClick={() => deleteQuery(q.id)} style={{ background: "none", border: "1px solid #2a1515", color: "#ef4444", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", fontSize: "11px" }}>Delete</button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────
function AuditLogsPage({ showNotif }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try { const data = await api("/audit-logs"); setLogs(data.logs || []); } catch (e) { showNotif(e.message, "error"); }
      setLoading(false);
    })();
  }, []);

  const actionColors = { login: "#6366f1", dataset_upload: "#10b981", dataset_delete: "#ef4444", query_execution: "#22d3ee", dashboard_create: "#f59e0b", dashboard_update: "#f59e0b", dashboard_delete: "#ef4444", user_created: "#10b981", user_role_change: "#f59e0b", user_status_change: "#f59e0b", user_delete: "#ef4444", password_change: "#8b5cf6", password_reset: "#8b5cf6", saved_query: "#6366f1", request_submit: "#22d3ee", request_status: "#f59e0b" };

  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>Audit Trail</h3>
      {loading ? <div style={{ textAlign: "center", padding: "32px" }}><span style={styles.spinner} /></div> :
        logs.length === 0 ? <div style={{ color: "#475569", textAlign: "center", padding: "32px" }}>No audit logs</div> :
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead><tr>{["Time", "User", "Action", "Details"].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr></thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id} style={{ borderBottom: "1px solid #0f0f1a" }}>
                  <td style={{ ...styles.td, fontSize: "11px" }}>{l.created_at}</td>
                  <td style={{ ...styles.td, color: "#e2e8f0" }}>{l.user_name || "System"}</td>
                  <td style={styles.td}><span style={{ background: (actionColors[l.action] || "#64748b") + "22", color: actionColors[l.action] || "#64748b", padding: "2px 8px", borderRadius: "12px", fontSize: "10px", fontFamily: "'JetBrains Mono',monospace" }}>{l.action}</span></td>
                  <td style={{ ...styles.td, color: "#64748b", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
      }
    </div>
  );
}

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────
function UserManagementPage({ users, setUsers, showNotif }) {
  const [form, setForm] = useState({ email: "", password: "", role: "viewer", name: "" });
  const [adding, setAdding] = useState(false);
  const [resetModal, setResetModal] = useState(null);
  const [newPassword, setNewPassword] = useState("");

  const addUser = async () => {
    if (!form.email || !form.name || !form.password) { showNotif("Fill all fields", "error"); return; }
    try { const data = await api("/users", { method: "POST", body: JSON.stringify(form) }); setUsers(prev => [...prev, data.user]); setForm({ email: "", password: "", role: "viewer", name: "" }); setAdding(false); showNotif("User added"); } catch (e) { showNotif(e.message, "error"); }
  };
  const removeUser = async (id) => { try { await api(`/users/${id}`, { method: "DELETE" }); setUsers(prev => prev.filter(u => u.id !== id)); showNotif("User removed"); } catch (e) { showNotif(e.message, "error"); } };
  const updateRole = async (id, role) => { try { await api(`/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }); setUsers(prev => prev.map(u => u.id === id ? { ...u, role } : u)); showNotif("Role updated"); } catch (e) { showNotif(e.message, "error"); } };
  const toggleActive = async (id, isActive) => { try { await api(`/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ is_active: isActive }) }); setUsers(prev => prev.map(u => u.id === id ? { ...u, is_active: isActive ? 1 : 0 } : u)); showNotif(isActive ? "User activated" : "User deactivated"); } catch (e) { showNotif(e.message, "error"); } };
  const resetPassword = async () => { if (!newPassword || newPassword.length < 6) { showNotif("Password must be at least 6 characters", "error"); return; } try { await api(`/users/${resetModal}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword }) }); setResetModal(null); setNewPassword(""); showNotif("Password reset"); } catch (e) { showNotif(e.message, "error"); } };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
        <button onClick={() => setAdding(!adding)} style={styles.primaryBtn}>+ Add User</button>
      </div>
      {adding && (
        <div style={{ ...styles.card, marginBottom: "16px", border: "1px solid #6366f1" }}>
          <h3 style={styles.cardTitle}>New User</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "10px", marginBottom: "12px" }}>
            <div><label style={styles.label}>Full Name</label><input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={styles.input} placeholder="Jane Smith" /></div>
            <div><label style={styles.label}>Email</label><input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} style={styles.input} placeholder="jane@company.com" /></div>
            <div><label style={styles.label}>Password</label><input value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} type="password" style={styles.input} placeholder="••••••••" /></div>
            <div><label style={styles.label}>Role</label><select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} style={styles.select}><option value="viewer">Viewer</option><option value="analyst">Analyst</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}><button onClick={addUser} style={styles.primaryBtn}>Save User</button><button onClick={() => setAdding(false)} style={styles.ghostBtn}>Cancel</button></div>
        </div>
      )}
      <div style={styles.card}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead><tr style={{ borderBottom: "1px solid #1e1e2e" }}>{["User", "Email", "Role", "Status", "Actions"].map(h => <th key={h} style={{ ...styles.th, textAlign: "left" }}>{h}</th>)}</tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: "1px solid #0f0f1a" }}>
                <td style={styles.td}><div style={{ display: "flex", alignItems: "center", gap: "8px" }}><div style={{ ...styles.avatar, width: "30px", height: "30px", fontSize: "11px" }}>{u.avatar}</div><span style={{ color: "#e2e8f0" }}>{u.name}</span></div></td>
                <td style={{ ...styles.td, color: "#64748b", fontFamily: "'JetBrains Mono',monospace" }}>{u.email}</td>
                <td style={styles.td}>
                  <select value={u.role} onChange={e => updateRole(u.id, e.target.value)}
                    style={{ ...styles.select, width: "auto", padding: "4px 8px", ...roleColors[u.role], border: "1px solid transparent" }}>
                    <option value="viewer">viewer</option><option value="analyst">analyst</option><option value="manager">manager</option><option value="admin">admin</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <span style={{ fontSize: "11px", color: u.is_active !== false ? "#10b981" : "#ef4444", background: u.is_active !== false ? "#10b98122" : "#ef444422", padding: "2px 10px", borderRadius: "20px" }}>{u.is_active !== false ? "Active" : "Inactive"}</span>
                </td>
                <td style={styles.td}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button onClick={() => toggleActive(u.id, u.is_active === false)} style={{ background: "none", border: `1px solid ${u.is_active !== false ? "#2a2a3e" : "#064e3b"}`, color: u.is_active !== false ? "#64748b" : "#10b981", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "11px" }}>{u.is_active !== false ? "Deactivate" : "Activate"}</button>
                    <button onClick={() => { setResetModal(u.id); setNewPassword(""); }} style={{ background: "none", border: "1px solid #1e1e2e", color: "#64748b", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "11px" }}>Reset PW</button>
                    <button onClick={() => removeUser(u.id)} style={{ background: "none", border: "1px solid #2a1515", color: "#ef4444", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "11px" }}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resetModal && (
        <div style={styles.modalOverlay} onClick={() => setResetModal(null)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.cardTitle}>Reset Password</h3>
            <div style={{ marginBottom: "12px" }}><label style={styles.label}>New Password</label><input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" style={styles.input} placeholder="Min 6 characters" /></div>
            <div style={{ display: "flex", gap: "8px" }}><button onClick={resetPassword} style={styles.primaryBtn}>Reset</button><button onClick={() => setResetModal(null)} style={styles.ghostBtn}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── REQUESTS PAGE ────────────────────────────────────────────────────────────
function RequestsPage({ requests, setRequests, user, showNotif }) {
  const [newReq, setNewReq] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitRequest = async () => { if (!newReq.trim()) return; setSubmitting(true); try { const data = await api("/requests", { method: "POST", body: JSON.stringify({ description: newReq }) }); setRequests(prev => [...prev, { id: data.id, requestedBy: user.id, description: newReq, status: "pending", date: new Date().toISOString().split("T")[0], requester: user.name }]); setNewReq(""); showNotif("Request submitted"); } catch (e) { showNotif(e.message, "error"); } finally { setSubmitting(false); } };
  const updateStatus = async (id, status) => { try { await api(`/requests/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); setRequests(prev => prev.map(r => r.id === id ? { ...r, status } : r)); showNotif(`Request ${status}`); } catch (e) { showNotif(e.message, "error"); } };
  const statusColor = { pending: "#f59e0b", approved: "#10b981", rejected: "#ef4444" };
  return (
    <div>
      {["manager", "analyst"].includes(user.role) && (
        <div style={{ ...styles.card, marginBottom: "16px" }}>
          <h3 style={styles.cardTitle}>Submit Dataset Request</h3>
          <textarea value={newReq} onChange={e => setNewReq(e.target.value)} style={styles.textarea} placeholder="Describe the dataset or action you need..." rows={3} />
          <button onClick={submitRequest} disabled={submitting || !newReq.trim()} style={{ ...styles.primaryBtn, marginTop: "10px", opacity: submitting ? 0.5 : 1 }}>{submitting ? "Submitting..." : "Submit Request"}</button>
        </div>
      )}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>{user.role === "admin" ? "All Requests" : "My Requests"}</h3>
        {requests.length === 0 && <div style={{ color: "#475569", textAlign: "center", padding: "32px", fontSize: "13px" }}>No requests yet</div>}
        {requests.map(r => (
          <div key={r.id} style={{ ...styles.listItem, flexDirection: "column", gap: "8px", alignItems: "stretch" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "13px", color: "#e2e8f0" }}>{r.description}</span>
              <span style={{ fontSize: "11px", color: statusColor[r.status], background: statusColor[r.status] + "22", padding: "2px 10px", borderRadius: "20px", fontFamily: "'JetBrains Mono',monospace" }}>{r.status}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", color: "#475569" }}>By {r.requester || "Unknown"} · {r.date}</span>
              {user.role === "admin" && r.status === "pending" && (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={() => updateStatus(r.id, "approved")} style={{ ...styles.primaryBtn, padding: "4px 12px", fontSize: "11px" }}>Approve</button>
                  <button onClick={() => updateStatus(r.id, "rejected")} style={{ background: "none", border: "1px solid #2a1515", color: "#ef4444", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", fontSize: "11px" }}>Reject</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <div style={{ ...styles.card, textAlign: "center", padding: "60px" }}>
      <div style={{ fontSize: "40px", marginBottom: "12px", opacity: 0.3 }}>⊘</div>
      <h3 style={{ color: "#e2e8f0", marginBottom: "8px" }}>Access Denied</h3>
      <p style={{ color: "#475569", fontSize: "13px" }}>You don't have permission to view this page.</p>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const roleColors = { admin: { color: "#c084fc", background: "#2e1065" }, manager: { color: "#38bdf8", background: "#0c2340" }, analyst: { color: "#4ade80", background: "#052e16" }, viewer: { color: "#fb923c", background: "#3d1a00" } };

const styles = {
  root: { display: "flex", minHeight: "100vh", background: "#080810", fontFamily: "'Syne',sans-serif", color: "#e2e8f0" },
  sidebar: { width: "240px", flexShrink: 0, background: "#0a0a14", borderRight: "1px solid #12121f", display: "flex", flexDirection: "column", padding: "0", height: "100vh", position: "sticky", top: 0 },
  main: { flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh", overflow: "auto" },
  logo: { display: "flex", alignItems: "center", gap: "12px", padding: "24px 20px 16px" },
  logoIcon: { width: "36px", height: "36px", borderRadius: "8px", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 800, color: "white" },
  logoText: { fontSize: "16px", fontWeight: 800, color: "#e2e8f0", lineHeight: 1 },
  logoSub: { fontSize: "10px", color: "#475569", letterSpacing: "0.15em", textTransform: "uppercase" },
  userCard: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 20px", borderTop: "1px solid #12121f", borderBottom: "1px solid #12121f", margin: "0 0 8px" },
  avatar: { width: "34px", height: "34px", borderRadius: "8px", background: "linear-gradient(135deg,#6366f1,#22d3ee)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700, color: "white", flexShrink: 0 },
  roleBadge: { fontSize: "10px", fontWeight: 600, padding: "1px 8px", borderRadius: "20px", display: "inline-block", marginTop: "2px", letterSpacing: "0.05em" },
  navBtn: { display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "9px 20px", background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: "13px", fontFamily: "'Syne',sans-serif", fontWeight: 500, transition: "all 0.15s", position: "relative", textAlign: "left" },
  navBtnActive: { color: "#e2e8f0", background: "#111120" },
  navIcon: { fontSize: "16px", width: "20px", textAlign: "center" },
  navIndicator: { position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)", width: "3px", height: "20px", borderRadius: "2px 0 0 2px", background: "#6366f1" },
  logoutBtn: { display: "flex", alignItems: "center", gap: "8px", padding: "16px 20px", background: "none", border: "none", cursor: "pointer", color: "#334155", fontSize: "13px", fontFamily: "'Syne',sans-serif", borderTop: "1px solid #12121f", width: "100%", marginTop: "auto" },
  header: { padding: "24px 32px 16px", borderBottom: "1px solid #0f0f1a", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#080810", position: "sticky", top: 0, zIndex: 10 },
  pageTitle: { fontSize: "22px", fontWeight: 800, color: "#e2e8f0", margin: 0 },
  pageSubtitle: { fontSize: "12px", color: "#334155", marginTop: "4px" },
  headerRight: { display: "flex", alignItems: "center", gap: "8px" },
  statusDot: { width: "7px", height: "7px", borderRadius: "50%", background: "#10b981", boxShadow: "0 0 0 2px #10b98133" },
  content: { padding: "24px 32px", flex: 1 },
  card: { background: "#0d0d1a", border: "1px solid #13132a", borderRadius: "12px", padding: "20px" },
  cardTitle: { fontSize: "13px", fontWeight: 700, color: "#64748b", marginBottom: "16px", letterSpacing: "0.08em", textTransform: "uppercase" },
  listItem: { display: "flex", alignItems: "center", gap: "12px", padding: "10px 0", borderBottom: "1px solid #0f0f1a" },
  iconBadge: { width: "32px", height: "32px", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  notif: { position: "fixed", top: "16px", right: "16px", padding: "12px 20px", borderRadius: "8px", fontSize: "13px", zIndex: 9999, border: "1px solid", fontFamily: "'Syne',sans-serif" },
  label: { display: "block", fontSize: "11px", color: "#475569", marginBottom: "6px", letterSpacing: "0.08em", textTransform: "uppercase" },
  input: { width: "100%", background: "#080810", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "9px 12px", color: "#e2e8f0", fontSize: "13px", fontFamily: "'Syne',sans-serif", outline: "none", boxSizing: "border-box" },
  select: { width: "100%", background: "#080810", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "9px 12px", color: "#e2e8f0", fontSize: "13px", fontFamily: "'Syne',sans-serif", outline: "none", cursor: "pointer" },
  textarea: { width: "100%", background: "#080810", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "12px", color: "#e2e8f0", fontSize: "13px", fontFamily: "'JetBrains Mono',monospace", outline: "none", boxSizing: "border-box" },
  primaryBtn: { background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", borderRadius: "8px", padding: "9px 20px", color: "white", fontSize: "13px", fontFamily: "'Syne',sans-serif", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px" },
  ghostBtn: { background: "none", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "9px 20px", color: "#94a3b8", fontSize: "13px", fontFamily: "'Syne',sans-serif", cursor: "pointer" },
  exampleBtn: { background: "#0a0a14", border: "1px solid #13132a", borderRadius: "20px", padding: "5px 12px", color: "#64748b", fontSize: "11px", fontFamily: "'JetBrains Mono',monospace", cursor: "pointer" },
  sqlBlock: { background: "#020208", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "14px 16px", marginTop: "14px" },
  th: { padding: "10px 12px", textAlign: "left", fontSize: "11px", fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", background: "#080810" },
  td: { padding: "10px 12px", fontSize: "12px", color: "#94a3b8", fontFamily: "'JetBrains Mono',monospace" },
  spinner: { display: "inline-block", width: "12px", height: "12px", border: "2px solid #ffffff44", borderTop: "2px solid white", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9998 },
  modal: { background: "#0d0d1a", border: "1px solid #1e1e2e", borderRadius: "12px", padding: "24px", width: "440px", maxWidth: "90vw" },
};

const loginStyles = {
  root: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#040408", position: "relative", overflow: "hidden" },
  bg: { position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 50% at 50% 50%, #0f0b2a 0%, transparent 70%)" },
  grid: { position: "absolute", inset: 0, backgroundImage: "linear-gradient(#13132a 1px, transparent 1px), linear-gradient(90deg, #13132a 1px, transparent 1px)", backgroundSize: "40px 40px", opacity: 0.4 },
  card: { background: "#0a0a14", border: "1px solid #1e1e2e", borderRadius: "16px", padding: "40px", width: "420px", position: "relative", zIndex: 1, backdropFilter: "blur(20px)" },
  logo: { textAlign: "center", marginBottom: "20px" },
  logoMark: { display: "inline-flex", width: "52px", height: "52px", borderRadius: "12px", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: 900, color: "white" },
  title: { fontSize: "24px", fontWeight: 900, color: "#e2e8f0", textAlign: "center", margin: "0 0 6px", fontFamily: "'Syne',sans-serif" },
  subtitle: { fontSize: "12px", color: "#475569", textAlign: "center", marginBottom: "24px" },
  demoRow: { display: "flex", gap: "6px", marginBottom: "20px", flexWrap: "wrap", justifyContent: "center" },
  demoBtn: { background: "transparent", border: "1px solid", borderRadius: "6px", padding: "5px 12px", fontSize: "11px", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 600, transition: "all 0.15s" },
  error: { background: "#2d0a0a", border: "1px solid #7f1d1d", borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: "#fca5a5", marginBottom: "12px" },
  field: { marginBottom: "14px" },
  label: { display: "block", fontSize: "11px", color: "#475569", marginBottom: "6px", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "'Syne',sans-serif" },
  input: { width: "100%", background: "#080810", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "11px 14px", color: "#e2e8f0", fontSize: "13px", fontFamily: "'Syne',sans-serif", outline: "none", boxSizing: "border-box" },
  btn: { width: "100%", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", borderRadius: "8px", padding: "12px", color: "white", fontSize: "14px", fontFamily: "'Syne',sans-serif", fontWeight: 700, cursor: "pointer", marginTop: "4px" },
};
