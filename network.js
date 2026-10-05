import { chartSeries, formatNumber, gamingAssessment, incidentTitle, networkHealthState } from "./network-model.mjs";

const $ = id => document.getElementById(id);
const BRIDGE = String(window.ROGGY_AI_CONFIG?.bridgeUrl || "").replace(/\/$/, "");
const RANGE_VALUES = new Set(["1h", "6h", "24h", "7d"]);
const STATE_LABELS = { healthy: "Healthy", degraded: "Degraded", offline: "Offline", unknown: "Unknown" };
const METRIC_LABELS = { latency: "Latency", jitter: "Jitter", loss: "Packet loss" };
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const number = (value, suffix = "") => formatNumber(value, suffix);
const onlineLabel = value => value === true ? "Online" : value === false ? "Offline" : "—";

let activePage = "home";
let statusData = null;
let summaryData = null;
let measurementData = null;
let incidentData = null;
let chart = null;
let pagePromise = null;
let refreshTimer = null;
let historyRequest = 0;

function friendlyError(error) {
  if (error?.code === "AUTHENTICATION_REQUIRED") return "Sign in to view private network health.";
  if (error?.code === "NETWORK_UNAVAILABLE" || error?.code === "NETWORK_TIMEOUT") return "NetworkWatch is temporarily unavailable.";
  return "Network health is temporarily unavailable.";
}

async function networkToken() {
  const result = await window.roggyGetSession?.();
  return result?.data?.session?.access_token || "";
}

async function networkFetch(path) {
  if (!BRIDGE) throw Object.assign(new Error("bridge unavailable"), { code: "NETWORK_UNAVAILABLE" });
  const token = await networkToken();
  if (!token) throw Object.assign(new Error("sign in required"), { code: "AUTHENTICATION_REQUIRED" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${BRIDGE}${path}`, { method: "GET", cache: "no-store", headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || "request failed"), { code: payload.error || "NETWORK_UNAVAILABLE", status: response.status });
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("request timed out"), { code: "NETWORK_TIMEOUT" });
    throw error;
  } finally { clearTimeout(timer); }
}

function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function duration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.round(value / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderHomeCard(data = statusData) {
  const card = $("homeNetworkCard");
  if (!card) return;
  const state = networkHealthState(data || {});
  card.dataset.state = state;
  const dot = card.querySelector(".network-status-dot");
  if (dot) dot.dataset.state = state;
  const message = $("homeNetworkMessage");
  const metric = $("homeNetworkMetric");
  if (state === "unknown") {
    if (message) message.textContent = data?.status === "STALE" ? "Monitor needs attention" : "Sign in to check internet health";
    if (metric) metric.textContent = "—";
  } else {
    if (message) message.textContent = `${STATE_LABELS[state]} · ${dateTime(data?.updated_at || data?.last_measurement_at)}`;
    if (metric) metric.textContent = number(data?.current_latency_ms, " ms");
  }
}

function renderStatus() {
  const card = $("networkStatusCard");
  if (!card) return;
  const data = statusData || {};
  const state = networkHealthState(data);
  card.dataset.state = state;
  const description = state === "healthy" ? "Gateway, internet, and DNS checks are responding normally." : state === "degraded" ? "The monitor sees a quality issue; inspect the evidence below." : state === "offline" ? "The monitor has evidence that internet reachability is down." : data.status === "STALE" ? "The monitor has not checked in recently." : "Sign in or wait for NetworkWatch to become available.";
  card.innerHTML = `<div class="network-status-heading"><span class="network-status-dot" data-state="${state}" aria-hidden="true"></span><div><span class="eyebrow">CURRENT STATUS</span><h2>${esc(STATE_LABELS[state])}</h2><p>${esc(description)}</p></div></div><div class="network-status-aside"><b>${esc(number(data.current_latency_ms, " ms"))}</b><small>current latency</small><small>Last check: ${esc(dateTime(data.updated_at || data.last_measurement_at))}</small></div>`;
}

function renderMetrics() {
  const root = $("networkMetrics");
  if (!root) return;
  const data = statusData || {};
  const cells = [
    ["Gateway", onlineLabel(data.gateway?.online), data.gateway?.latency_ms == null ? "Reachability" : `${number(data.gateway.latency_ms, " ms")} response`],
    ["Internet", onlineLabel(data.internet?.online), data.internet?.successes == null ? "External probes" : `${data.internet.successes}/${data.internet.total ?? "—"} probes`],
    ["DNS", onlineLabel(data.dns?.online), "Resolver probe"],
    ["Latency", number(data.current_latency_ms, " ms"), "Current external median"],
    ["Jitter", number(data.current_jitter_ms, " ms"), "Cycle-to-cycle change"],
    ["Packet loss", number(data.packet_loss_5m_pct, "%"), "Recent external probes"],
  ];
  root.innerHTML = cells.map(([label, value, note]) => `<article class="network-metric"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></article>`).join("");
}

function renderSummary() {
  const root = $("networkSummaryCard");
  if (!root) return;
  const report = summaryData || {};
  const summary = measurementData?.summary || {};
  if (!report || report.status === "INTEGRATION_UNAVAILABLE") {
    root.innerHTML = `<span class="eyebrow">RELIABILITY</span><h3>Summary unavailable</h3><p class="quiet-state">${esc(friendlyError(report?.error))}</p>`;
    return;
  }
  const availability = report.measured_external_availability_pct ?? report.availability_pct_after_debounced_incidents;
  const cells = [
    ["Availability", number(availability, "%")],
    ["Median latency", number(report.median_latency_ms ?? summary.average_latency_ms, " ms")],
    ["95th percentile", number(report.p95_latency_ms, " ms")],
    ["Packet loss", number(report.external_packet_loss_pct ?? summary.average_packet_loss_pct, "%")],
    ["Outage events", report.outage_events ?? "—"],
    ["Degraded events", report.degradation_events ?? "—"],
  ];
  root.innerHTML = `<div class="section-head"><div><span class="eyebrow">${esc(String(report.period || "24h").toUpperCase())} WINDOW</span><h3>Reliability at a glance</h3></div><span class="network-summary-duration">${esc(report.monitoring_duration || "Stored measurements")}</span></div><div class="network-summary-grid">${cells.map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(String(value))}</b></div>`).join("")}</div>`;
}

function chartColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8bd4c7";
}

function drawFallback(canvas, series) {
  const points = series.values.map((value, index) => ({ value, index })).filter(point => point.value !== null);
  const context = canvas.getContext?.("2d");
  if (!context || !points.length) return;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 250;
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale; canvas.height = height * scale; context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const spread = Math.max(1, max - min);
  context.strokeStyle = chartColor(); context.lineWidth = 2; context.beginPath();
  points.forEach((point, index) => { const x = points.length === 1 ? width / 2 : point.index / Math.max(1, series.values.length - 1) * width; const y = height - 12 - ((point.value - min) / spread) * (height - 24); if (!index) context.moveTo(x, y); else context.lineTo(x, y); });
  context.stroke();
}

function renderChart() {
  const canvas = $("networkChart");
  const empty = $("networkChartEmpty");
  const note = $("networkChartNote");
  const metric = $("networkMetric")?.value || "latency";
  const series = chartSeries(measurementData || {}, metric);
  const hasPoint = series.values.some(value => value !== null);
  if (chart) { chart.destroy(); chart = null; }
  if (canvas) canvas.hidden = !hasPoint;
  if (empty) { empty.hidden = hasPoint; empty.textContent = measurementData?.status === "INTEGRATION_UNAVAILABLE" ? friendlyError(measurementData?.error) : "No measurements in this range."; }
  if (!hasPoint) return;
  $("networkChartTitle").textContent = METRIC_LABELS[metric] || "Latency";
  const unit = metric === "loss" ? "%" : "ms";
  if (window.Chart) {
    chart = new window.Chart(canvas, { type: "line", data: { labels: series.labels, datasets: [{ label: METRIC_LABELS[metric], data: series.values, borderColor: chartColor(), backgroundColor: chartColor(), pointRadius: 0, borderWidth: 2, spanGaps: false, tension: 0.22 }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6, color: "#8b929b" }, grid: { display: false } }, y: { beginAtZero: metric === "loss", ticks: { color: "#8b929b", callback: value => `${value}${unit}` }, grid: { color: "rgba(139,146,155,.14)" } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.parsed.y}${unit}` } } } } });
  } else drawFallback(canvas, series);
  if (note) note.textContent = `${measurementData?.measurement_count || series.points.length} bounded cycle points · Jitter is derived as the absolute change between successive cycle median external latencies.${measurementData?.truncated ? " History was downsampled to keep the chart light." : ""}`;
}

function renderIncidents() {
  const root = $("networkIncidentList");
  if (!root) return;
  const incidents = Array.isArray(incidentData?.incidents) ? incidentData.incidents : [];
  $("networkIncidentCount").textContent = incidentData?.count ?? incidents.length;
  if (!incidents.length) { root.innerHTML = `<p class="quiet-state">No recorded incidents in this range.</p>`; return; }
  root.innerHTML = incidents.map((incident, index) => `<button type="button" class="network-incident" data-network-incident="${index}"><span class="network-incident-bar" data-severity="${esc(incident.severity || "UNKNOWN")}" aria-hidden="true"></span><span><b>${esc(incidentTitle(incident.classification))}</b><small>${esc(dateTime(incident.start_time))} · ${esc(duration(incident.duration_seconds))}</small></span><span class="network-incident-arrow" aria-hidden="true">›</span></button>`).join("");
}

function renderGaming() {
  const root = $("networkGamingCard");
  if (!root) return;
  const assessment = gamingAssessment(statusData || {}, measurementData || {});
  root.dataset.state = assessment.state;
  root.innerHTML = `<div class="section-head"><div><span class="eyebrow">GAMING VIEW</span><h3>${esc(assessment.label)}</h3></div><span class="network-gaming-state">${esc(assessment.state === "unknown" ? "Evidence needed" : "Based on measured quality")}</span></div><p>${assessment.factors.length ? `Measured factors: ${esc(assessment.factors.join(" · "))}.` : "NetworkWatch has not collected enough recent data to judge game quality."}</p><small>Heuristic only: latency, jitter, and packet loss are shown; no synthetic score is claimed.</small>`;
}

function renderPage() {
  renderStatus(); renderMetrics(); renderSummary(); renderIncidents(); renderGaming(); renderChart(); renderHomeCard();
}

async function loadHomeNetworkCard() {
  try { statusData = await networkFetch("/network/status"); renderHomeCard(); }
  catch (error) { statusData = { status: error.code === "AUTHENTICATION_REQUIRED" ? "AUTH_REQUIRED" : "MONITOR_UNAVAILABLE", stale: true }; renderHomeCard(); }
}

async function loadNetworkPage() {
  if (pagePromise) return pagePromise;
  pagePromise = (async () => {
    const pageStatus = $("networkPageStatus");
    if (pageStatus) pageStatus.textContent = "Loading current NetworkWatch data…";
    try {
      statusData = await networkFetch("/network/status");
      const range = RANGE_VALUES.has($("networkRange")?.value) ? $("networkRange").value : "24h";
      const request = ++historyRequest;
      const results = await Promise.allSettled([
        networkFetch(`/network/summary?range=${encodeURIComponent(range)}`),
        networkFetch(`/network/incidents?range=${encodeURIComponent(range)}&limit=50`),
        networkFetch(`/network/measurements?range=${encodeURIComponent(range)}&limit=600`),
      ]);
      if (request !== historyRequest) return;
      summaryData = results[0].status === "fulfilled" ? results[0].value : null;
      incidentData = results[1].status === "fulfilled" ? results[1].value : null;
      measurementData = results[2].status === "fulfilled" ? results[2].value : null;
      renderPage();
      if (pageStatus) pageStatus.textContent = results.every(result => result.status === "fulfilled") ? "" : "Some history is temporarily unavailable.";
    } catch (error) {
      statusData = { status: error.code === "AUTHENTICATION_REQUIRED" ? "AUTH_REQUIRED" : "MONITOR_UNAVAILABLE", stale: true, error: { code: error.code } };
      summaryData = incidentData = measurementData = null;
      renderPage();
      if (pageStatus) pageStatus.textContent = friendlyError(error);
    } finally { pagePromise = null; }
  })();
  return pagePromise;
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (activePage === "network") loadNetworkPage().catch(() => {});
    else if (activePage === "home") loadHomeNetworkCard().catch(() => {});
  }, 20000);
}

function stopRefresh() { clearInterval(refreshTimer); refreshTimer = null; }

function showIncident(index) {
  const incident = incidentData?.incidents?.[Number(index)];
  if (!incident) return;
  $("networkIncidentTitle").textContent = incidentTitle(incident.classification);
  $("networkIncidentDetail").innerHTML = `<dl class="network-detail-list"><div><dt>Started</dt><dd>${esc(dateTime(incident.start_time))}</dd></div><div><dt>Ended</dt><dd>${esc(dateTime(incident.end_time))}</dd></div><div><dt>Duration</dt><dd>${esc(duration(incident.duration_seconds))}</dd></div><div><dt>Severity</dt><dd>${esc(incident.severity || "—")}</dd></div><div><dt>Gateway evidence</dt><dd>${esc(onlineLabel(incident.gateway_reachable))}</dd></div><div><dt>Worst latency</dt><dd>${esc(number(incident.worst_latency_ms, " ms"))}</dd></div><div><dt>Worst packet loss</dt><dd>${esc(number(incident.worst_packet_loss_pct, "%"))}</dd></div></dl><p class="network-incident-note">${esc(incident.notes || "Classification is based on the stored gateway, DNS, and external-probe evidence; it is a cautious diagnosis, not a guarantee of root cause.")}</p>`;
  $("networkIncidentDialog")?.showModal();
}

document.addEventListener("click", event => {
  const incidentButton = event.target.closest?.("[data-network-incident]");
  if (incidentButton) showIncident(incidentButton.dataset.networkIncident);
  const layneButton = event.target.closest?.("[data-network-prompt]");
  if (layneButton) window.roggyAskLayne?.(layneButton.dataset.networkPrompt);
});
$("networkHomeCard")?.addEventListener("click", () => document.querySelector('.drawer-page-tab[data-page="network"]')?.click());
$("networkRange")?.addEventListener("change", () => loadNetworkPage().catch(() => {}));
$("networkMetric")?.addEventListener("change", renderChart);
$("closeNetworkIncident")?.addEventListener("click", () => $("networkIncidentDialog")?.close());
$("networkIncidentDialog")?.addEventListener("click", event => { if (event.target === $("networkIncidentDialog")) $("networkIncidentDialog").close(); });

window.renderNetworkPage = () => { activePage = "network"; startRefresh(); loadNetworkPage().catch(() => {}); };
window.loadNetworkHomeCard = loadHomeNetworkCard;
window.addEventListener("roggy-page", event => {
  activePage = event.detail?.page || "home";
  if (activePage === "network") { startRefresh(); loadNetworkPage().catch(() => {}); }
  else if (activePage === "home") { startRefresh(); loadHomeNetworkCard().catch(() => {}); }
  else stopRefresh();
});
window.addEventListener("roggy-auth", () => {
  if (activePage === "network") loadNetworkPage().catch(() => {});
  else if (activePage === "home") loadHomeNetworkCard().catch(() => {});
});
loadHomeNetworkCard().catch(() => {});
