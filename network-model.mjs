const NUMBER = value => typeof value === "number" && Number.isFinite(value) ? value : null;

export function networkHealthState(payload = {}) {
  if (!payload || payload.status !== "RUNNING" || payload.stale) return "unknown";
  const gateway = payload.gateway || {};
  const internet = payload.internet || {};
  if (gateway.online === false && internet.online === false) return "offline";
  if (payload.classification === "LOCAL_NETWORK_OR_ROUTER_FAILURE" && gateway.online === false) return "offline";
  if (payload.classification === "ISP_OR_UPSTREAM_OUTAGE" && internet.online === false && Number(internet.successes || 0) === 0) return "offline";
  if (payload.classification === "NORMAL") return "healthy";
  if (gateway.online === false || internet.online === false || payload.dns?.online === false) return "degraded";
  return "degraded";
}

export function chartSeries(payload = {}, metric = "latency") {
  const key = metric === "jitter" ? "jitter_ms" : metric === "loss" ? "packet_loss_pct" : "latency_ms";
  const points = Array.isArray(payload.measurements) ? payload.measurements : [];
  return {
    key,
    labels: points.map(point => point.timestamp || point.timestamp_epoch || ""),
    values: points.map(point => NUMBER(point[key])),
    points,
  };
}

export function incidentTitle(classification) {
  return {
    LOCAL_NETWORK_OR_ROUTER_FAILURE: "Likely local gateway / Wi-Fi issue",
    ISP_OR_UPSTREAM_OUTAGE: "Likely ISP / upstream issue",
    DNS_FAILURE: "DNS failure",
    DEGRADED: "Degraded / high-jitter event",
  }[classification] || String(classification || "Network event").toLowerCase().replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export function gamingAssessment(status = {}, measurements = {}) {
  const summary = measurements.summary || {};
  const latency = NUMBER(status.current_latency_ms) ?? NUMBER(summary.average_latency_ms);
  const jitter = NUMBER(status.current_jitter_ms) ?? NUMBER(summary.average_jitter_ms);
  const loss = NUMBER(status.packet_loss_5m_pct) ?? NUMBER(summary.average_packet_loss_pct);
  if (latency === null && jitter === null && loss === null) return { state: "unknown", label: "Not enough data", factors: [] };
  const factors = [];
  if (latency !== null) factors.push(`${Math.round(latency)} ms latency`);
  if (jitter !== null) factors.push(`${Math.round(jitter)} ms jitter`);
  if (loss !== null) factors.push(`${Number(loss.toFixed(1))}% packet loss`);
  if ((loss !== null && loss > 2) || (latency !== null && latency > 100) || (jitter !== null && jitter > 30)) return { state: "poor", label: "Poor for gaming", factors };
  if ((loss !== null && loss > 0.5) || (latency !== null && latency > 60) || (jitter !== null && jitter > 15)) return { state: "fair", label: "Watch for instability", factors };
  return { state: "good", label: "Good for gaming", factors };
}

export function formatNumber(value, suffix = "") {
  const number = NUMBER(value);
  return number === null ? "—" : `${Number(number.toFixed(1))}${suffix}`;
}
