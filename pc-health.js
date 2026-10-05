const $ = id => document.getElementById(id);
const BRIDGE = String(window.ROGGY_AI_CONFIG?.bridgeUrl || "").replace(/\/$/, "");
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const stateLabels = { healthy: "Healthy", elevated: "Elevated Load", critical: "Critical", unavailable: "Unavailable", unknown: "Unavailable" };
const metricLabels = { cpuPercent: "CPU", ramPercent: "RAM", gpuPercent: "GPU", vramPercent: "VRAM", diskActivePercent: "Disk" };

let activePage = "home";
let current = null;
let history = null;
let events = null;
let chart = null;
let pagePromise = null;
let homePromise = null;
let refreshTimer = null;
let codexStopState = { state: "idle", message: "No remote stop requested.", result: null };

function number(value, suffix = "") {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${Math.round(parsed * 10) / 10}${suffix}` : "Unavailable";
}
function dateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function ageLabel(value) {
  if (!value) return "No successful update";
  const age = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(age)) return "No successful update";
  const seconds = Math.round(age / 1000);
  return seconds < 10 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
function statusState(data) {
  if (!data || data.stale || data.status === "unavailable") return "unavailable";
  return ["healthy", "elevated", "critical"].includes(data.status) ? data.status : "unknown";
}
function friendlyError(error) {
  if (error?.code === "AUTHENTICATION_REQUIRED") return "Sign in to view private PC health.";
  const detail = error?.error_detail || error?.error;
  return detail?.message || (error?.code === "PC_HEALTH_TIMEOUT" ? "PC health timed out." : "PC health is temporarily unavailable.");
}
async function token() {
  const result = await window.roggyGetSession?.();
  return result?.data?.session?.access_token || "";
}
async function fetchHealth(path) {
  if (!BRIDGE) throw Object.assign(new Error("bridge unavailable"), { code: "PC_HEALTH_UNAVAILABLE" });
  const accessToken = await token();
  if (!accessToken) throw Object.assign(new Error("sign in required"), { code: "AUTHENTICATION_REQUIRED" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${BRIDGE}${path}`, { method: "GET", cache: "no-store", headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error_detail || (payload?.error && typeof payload.error === "object" ? payload.error : null);
    const code = detail?.error_code || detail?.code || (typeof payload?.error === "string" ? payload.error : "PC_HEALTH_UNAVAILABLE");
    if (!response.ok) throw Object.assign(new Error(detail?.message || code), { code, status: response.status, error_detail: detail, error: payload?.error });
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("request timed out"), { code: "PC_HEALTH_TIMEOUT" });
    throw error;
  } finally { clearTimeout(timer); }
}

function renderHomeCard(data = current) {
  const card = $("homePcHealthCard");
  if (!card) return;
  const state = statusState(data);
  card.dataset.state = state;
  card.querySelector(".pc-health-status-dot")?.setAttribute("data-state", state);
  const message = $("homePcHealthMessage");
  const metric = $("homePcHealthMetric");
  if (state === "unavailable" || state === "unknown") {
    if (message) message.textContent = data?.stale ? `Stale · last update ${ageLabel(data.timestamp)}` : "Sign in to check PC health";
    if (metric) metric.textContent = "—";
    return;
  }
  const memory = data.memory?.percent;
  const suffix = data.heavyWork?.allowed === false ? "Heavy work deferred" : memory != null ? `RAM ${number(memory, "%")}` : dateTime(data.timestamp);
  if (message) message.textContent = `${stateLabels[state]} · ${suffix}`;
  if (metric) metric.textContent = ageLabel(data.timestamp);
}

function renderStatus() {
  const root = $("pcHealthStatusCard");
  if (!root) return;
  const state = statusState(current);
  if (state === "unavailable" || state === "unknown") {
    root.dataset.state = "unavailable";
    root.innerHTML = `<div class="pc-health-status-heading"><span class="pc-health-status-dot" data-state="unavailable" aria-hidden="true"></span><div><span class="eyebrow">PC STATUS</span><h2>Unavailable</h2><p>${esc(current?.stale ? `Last successful update ${ageLabel(current.timestamp)}.` : "Sign in or wait for the local monitor to respond.")}</p></div></div>`;
    return;
  }
  root.dataset.state = state;
  root.innerHTML = `<div class="pc-health-status-heading"><span class="pc-health-status-dot" data-state="${state}" aria-hidden="true"></span><div><span class="eyebrow">PC STATUS</span><h2>${esc(stateLabels[state])}</h2><p>Last update ${esc(dateTime(current.timestamp))} · ${esc(ageLabel(current.timestamp))}</p></div></div><div class="pc-health-status-aside"><b>${esc(formatUptime(current.uptimeSeconds))}</b><small>uptime</small><small>Booted ${esc(dateTime(current.bootTime))}</small></div>`;
}
function formatUptime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "Unavailable";
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function renderHeavyWork() {
  const root = $("pcHealthHeavyWork");
  if (!root) return;
  const heavy = current?.heavyWork;
  if (!heavy) { root.innerHTML = `<span class="eyebrow">HEAVY WORK</span><b>Unavailable</b><p>Resource policy evidence is not available.</p>`; return; }
  const allowed = heavy.allowed !== false;
  const reasons = Array.isArray(heavy.reasons) ? heavy.reasons : [];
  root.dataset.state = allowed ? "allowed" : "deferred";
  root.innerHTML = `<div><span class="eyebrow">HEAVY WORK</span><h3>${allowed ? "ALLOWED" : "DEFERRED"}</h3><p>${esc(allowed ? "The existing LocalAgent resource policy currently permits optional heavy work." : "Optional heavy work is being held until resource headroom returns.")}</p></div>${reasons.length ? `<ul>${reasons.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}`;
}
function renderCodexStop() {
  const root = $("pcHealthCodexStop");
  if (!root) return;
  const pending = codexStopState.state === "stopping";
  root.dataset.state = codexStopState.state;
  root.innerHTML = `<div class="pc-health-codex-stop-copy"><span class="eyebrow">REMOTE CONTROL</span><h3>Stop active Codex work</h3><p>Stops currently running Codex prompts on this PC.</p></div><div class="pc-health-codex-stop-action"><button type="button" class="pc-health-codex-stop-button" aria-describedby="pcHealthCodexStopDescription" ${pending ? "disabled" : ""}>${pending ? "STOPPING…" : "STOP CODEX"}</button><p id="pcHealthCodexStopDescription" class="pc-health-codex-stop-status" role="status">${esc(codexStopState.message)}</p></div>`;
  root.querySelector("button")?.addEventListener("click", requestCodexStop);
}
async function requestCodexStop() {
  if (codexStopState.state === "stopping") return;
  if (!window.confirm("Stop all currently running Codex prompts on this PC? Codex will remain open so you can resume afterward.")) return;
  codexStopState = { state: "stopping", message: "Stopping Codex…", result: null };
  renderCodexStop();
  try {
    const result = await postHealth("/pc-health/codex/stop");
    const stopped = Number(result?.stop_actions || 0);
    if (result?.verified_stopped === true) {
      codexStopState = { state: "success", message: `Codex stopped${stopped ? ` · ${stopped} active prompt${stopped === 1 ? "" : "s"} stopped` : ""}. Codex remains open.`, result };
    } else if (result?.status === "no_active_prompt" && result?.verified_no_active_work === true) {
      codexStopState = { state: "success", message: "No active Codex prompt found.", result };
    } else if (result?.status === "window_not_found") {
      codexStopState = { state: "error", message: "Codex window not found.", result };
    } else {
      codexStopState = { state: "error", message: `Stop failed: ${result?.failure_reason || result?.status || "verification failed"}.`, result };
    }
  } catch (error) {
    codexStopState = { state: "error", message: `Stop failed: ${friendlyError(error)}`, result: null };
  }
  renderCodexStop();
}
function renderMetrics() {
  const root = $("pcHealthMetrics");
  if (!root) return;
  const memory = current?.memory || {}, gpu = current?.gpu || {}, disk = current?.disk || {}, network = current?.network || {};
  const cells = [
    ["CPU", number(current?.cpu?.percent, "%"), "system use"],
    ["Memory", memory.totalGb == null ? "Unavailable" : `${number(memory.usedGb)} / ${number(memory.totalGb)} GB`, memory.percent == null ? "Unavailable" : number(memory.percent, "%")],
    ["Commit", memory.commitLimitGb == null ? "Unavailable" : `${number(memory.commitUsedGb)} / ${number(memory.commitLimitGb)} GB`, memory.commitPercent == null ? "Unavailable" : number(memory.commitPercent, "%")],
    ["GPU", number(gpu.percent, "%"), gpu.name || "NVIDIA GPU"],
    ["VRAM", gpu.vramTotalGb == null ? "Unavailable" : `${number(gpu.vramUsedGb)} / ${number(gpu.vramTotalGb)} GB`, gpu.vramPercent == null ? "Unavailable" : number(gpu.vramPercent, "%")],
    ["GPU Temp", number(gpu.temperatureC, "°C"), gpu.powerW == null ? "power unavailable" : `${number(gpu.powerW)} W`],
    ["Disk", disk.activePercent == null ? "Unavailable" : `${number(disk.activePercent, "%")} active`, `Read ${number(disk.readMbps)} MB/s · Write ${number(disk.writeMbps)} MB/s`],
    ["Network", network.status ? String(network.status).replace(/^./, letter => letter.toUpperCase()) : "Unavailable", network.latencyMs == null ? "Latency unavailable" : `${number(network.latencyMs, " ms")} · ${number(network.packetLossPercent, "%")} loss`],
  ];
  root.innerHTML = cells.map(([label, value, note]) => `<article class="pc-health-metric"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></article>`).join("");
}
function chartColor() { return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8bd4c7"; }
function renderChart() {
  const canvas = $("pcHealthChart"), empty = $("pcHealthChartEmpty"), note = $("pcHealthChartNote");
  const metric = $("pcHealthMetricSelect")?.value || "cpuPercent";
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  const values = samples.map(sample => sample?.[metric] == null ? null : Number(sample[metric]));
  const hasPoint = values.some(value => Number.isFinite(value));
  if (chart) { chart.destroy(); chart = null; }
  if (canvas) canvas.hidden = !hasPoint;
  if (empty) { empty.hidden = hasPoint; empty.textContent = history ? "No trend samples yet." : "PC health history is unavailable."; }
  $("pcHealthChartTitle").textContent = `${metricLabels[metric] || "CPU"} trend`;
  if (!hasPoint) return;
  const labels = samples.map(sample => dateTime(sample.timestamp));
  if (window.Chart) {
    chart = new window.Chart(canvas, { type: "line", data: { labels, datasets: [{ label: metricLabels[metric], data: values, borderColor: chartColor(), backgroundColor: chartColor(), pointRadius: 0, borderWidth: 2, spanGaps: false, tension: 0.22 }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6, color: "#8b929b" }, grid: { display: false } }, y: { beginAtZero: true, suggestedMax: metric === "diskActivePercent" || metric === "ramPercent" || metric === "gpuPercent" || metric === "vramPercent" ? 100 : undefined, ticks: { color: "#8b929b", callback: value => `${value}%` }, grid: { color: "rgba(139,146,155,.14)" } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.parsed.y}%` } } } } });
  }
  if (note) note.textContent = `${samples.length} bounded samples · refreshed about every ${history.sampleIntervalSeconds || 7}s.`;
}
function renderProcesses() {
  const root = $("pcHealthProcesses");
  if (!root) return;
  const items = Array.isArray(current?.importantProcesses) ? current.importantProcesses : [];
  if (!items.length) { root.innerHTML = `<p class="quiet-state">Process evidence is unavailable.</p>`; return; }
  const services = new Map((Array.isArray(current?.services) ? current.services : []).map(service => [service.name, service]));
  root.innerHTML = items.map(item => {
    const service = services.get(item.name);
    const serviceRunning = service?.state === "running";
    const healthy = service?.health !== "unhealthy";
    const available = Boolean(item.running || (serviceRunning && healthy));
    const label = item.running ? "Running" : serviceRunning && healthy ? "Service healthy" : item.optional ? "Not running" : "Unavailable";
    return `<article class="pc-health-process" data-running="${available ? "true" : "false"}"><div><b>${esc(item.name)}</b><small>${label}${item.instances ? ` · ${item.instances} instance${item.instances === 1 ? "" : "s"}` : ""}</small></div><span>${item.ramGb == null ? "—" : `${number(item.ramGb)} GB`}<small>${item.cpuPercent == null ? "CPU —" : `CPU ${number(item.cpuPercent, "%")}`}</small></span></article>`;
  }).join("");
}
async function postHealth(path, body = {}) {
  if (!BRIDGE) throw Object.assign(new Error("bridge unavailable"), { code: "PC_HEALTH_UNAVAILABLE" });
  const accessToken = await token();
  if (!accessToken) throw Object.assign(new Error("sign in required"), { code: "AUTHENTICATION_REQUIRED" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${BRIDGE}${path}`, { method: "POST", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body), signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error_detail || (payload?.error && typeof payload.error === "object" ? payload.error : null);
    const code = detail?.error_code || detail?.code || (typeof payload?.error === "string" ? payload.error : "PC_HEALTH_ACTION_FAILED");
    if (!response.ok) throw Object.assign(new Error(detail?.message || code), { code, status: response.status, error_detail: detail, error: payload?.error });
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("request timed out"), { code: "PC_HEALTH_TIMEOUT" });
    throw error;
  } finally { clearTimeout(timer); }
}
function renderEvents() {
  const root = $("pcHealthEvents");
  if (!root) return;
  const rows = Array.isArray(events?.events) ? events.events : [];
  $("pcHealthEventCount").textContent = events?.count ?? rows.length;
  root.innerHTML = rows.length ? rows.map(event => `<article class="pc-health-event" data-severity="${esc(event.severity || "info")}"><span class="pc-health-event-bar" aria-hidden="true"></span><div><b>${esc(event.title || "PC health event")}</b><small>${esc(dateTime(event.timestamp))}</small><p>${esc(event.explanation || "")}</p></div></article>`).join("") : `<p class="quiet-state">No notable PC health changes recorded yet.</p>`;
}
function renderPage() { renderStatus(); renderHeavyWork(); renderCodexStop(); renderMetrics(); renderChart(); renderProcesses(); renderEvents(); renderHomeCard(); }
function loadHome() {
  if (homePromise) return homePromise;
  homePromise = (async () => {
    try { current = await fetchHealth("/pc-health"); renderHomeCard(); }
    catch (error) { current = { status: error.code === "AUTHENTICATION_REQUIRED" ? "unknown" : "unavailable", stale: true }; renderHomeCard(); }
  })().finally(() => { homePromise = null; });
  return homePromise;
}
async function loadPage() {
  if (pagePromise) return pagePromise;
  pagePromise = (async () => {
    const status = $("pcHealthPageStatus");
    if (status) status.textContent = "Loading current PC health…";
    try {
      // Load the glanceable current state first. The bridge also serves network,
      // camera, and smart-home reads, so avoid a three-request burst on entry.
      const currentResult = (await Promise.allSettled([fetchHealth("/pc-health")]))[0];
      current = currentResult.status === "fulfilled" ? currentResult.value : { status: "unavailable", stale: true };
      renderPage();
      const [historyResult, eventsResult] = await Promise.allSettled([fetchHealth("/pc-health/history?limit=270"), fetchHealth("/pc-health/events?limit=50")]);
      history = historyResult.status === "fulfilled" ? historyResult.value : null;
      events = eventsResult.status === "fulfilled" ? eventsResult.value : null;
      renderPage();
      const unavailable = [];
      if (currentResult.status !== "fulfilled") unavailable.push("current status");
      if (historyResult.status !== "fulfilled") unavailable.push("trend history");
      if (eventsResult.status !== "fulfilled") unavailable.push("notable events");
      if (status) status.textContent = unavailable.length ? `${unavailable.join(" and ")} temporarily unavailable.` : "";
    } catch (error) {
      current = { status: "unavailable", stale: true };
      history = events = null;
      renderPage();
      if (status) status.textContent = friendlyError(error);
    } finally { pagePromise = null; }
  })();
  return pagePromise;
}
function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (activePage === "pc-health") loadPage().catch(() => {});
    else if (activePage === "home") loadHome().catch(() => {});
  }, 7000);
}
function stopRefresh() { clearInterval(refreshTimer); refreshTimer = null; }

$("homePcHealthCard")?.addEventListener("click", () => document.querySelector('.drawer-page-tab[data-page="pc-health"]')?.click());
$("pcHealthMetricSelect")?.addEventListener("change", renderChart);
window.renderPcHealthPage = () => { activePage = "pc-health"; startRefresh(); loadPage().catch(() => {}); };
window.addEventListener("roggy-page", event => {
  activePage = event.detail?.page || "home";
  if (activePage === "pc-health") { startRefresh(); loadPage().catch(() => {}); }
  else if (activePage === "home") { startRefresh(); loadHome().catch(() => {}); }
  else stopRefresh();
});
window.addEventListener("roggy-auth", () => { if (activePage === "pc-health") loadPage().catch(() => {}); else if (activePage === "home") loadHome().catch(() => {}); });
loadHome().catch(() => {});
