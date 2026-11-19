(() => {
  const $ = (id) => document.getElementById(id);
  const apiBase = () => {
    const current = window.location;
    if (current.protocol === "http:" && current.hostname === "127.0.0.1" && current.port === "8766") {
      return "http://127.0.0.1:8776";
    }
    return String(window.ROGGY_AI_CONFIG?.smartHomeUrl || "").replace(/\/+$/, "");
  };
  const setStatus = (message, tone) => {
    const node = $("layneGarminManagerStatus");
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone || "";
  };
  const ownerRequest = async (path, options) => {
    options = options || {};
    const client = window.roggySupabase;
    if (!client?.auth?.getSession) throw new Error("sign_in_required");
    const result = await client.auth.getSession();
    if (result.error) throw new Error("session_unavailable");
    const session = result.data?.session;
    if (!session?.access_token || session.user?.id !== window.ROGGY_OWNER_USER_ID) {
      throw new Error("sign_in_required");
    }
    const base = apiBase();
    if (!base) throw new Error("service_not_configured");
    const headers = {
      Accept: "application/json",
      Authorization: "Bearer " + session.access_token,
    };
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(base + path, {
      cache: "no-store",
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload?.error?.code || "http_" + response.status));
    return payload;
  };
  const errorLabel = (error) => {
    if (error?.message === "sign_in_required") return "Sign in as the owner to manage paired watches.";
    if (error?.message === "service_not_configured") return "Layne's service bridge is not configured.";
    if (error?.message === "garmin_device_auth_unavailable" || error?.message === "http_404") {
      return "Pairing controls are waiting for the Smart Home service update.";
    }
    return "Could not complete the request (" + (error?.message || "network_error") + ").";
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  const renderDevices = (devices) => {
    const list = $("layneGarminDeviceList");
    if (!list) return;
    if (!devices.length) {
      list.innerHTML = '<p class="laynegarmin-empty">No paired watches yet.</p>';
      return;
    }
    list.innerHTML = devices.map((device) => {
      const id = escapeHtml(device.device_id);
      const name = escapeHtml(device.device_name);
      const transcript = Array.isArray(device.scopes) && device.scopes.includes("transcripts:read");
      const state = device.revoked ? "Revoked" : "Active";
      const seen = device.last_seen_at
        ? "Last seen " + escapeHtml(new Date(device.last_seen_at).toLocaleString())
        : "Not seen yet";
      return '<article class="laynegarmin-device-card" data-device-id="' + id + '">' +
        '<div class="laynegarmin-device-copy"><b>' + name + '</b><small>' + state + ' · ' + seen + '</small></div>' +
        '<label class="laynegarmin-transcript-scope"><input type="checkbox" data-transcript-scope ' +
        (transcript ? "checked" : "") + (device.revoked ? " disabled" : "") +
        '><span>Allow transcript access</span></label>' +
        (device.revoked ? "" : '<button type="button" class="laynegarmin-revoke" data-revoke>Revoke</button>') +
        '</article>';
    }).join("");
  };

  const loadDevices = async () => {
    setStatus("Loading paired watches…");
    try {
      const result = await ownerRequest("/api/garmin/devices");
      renderDevices(Array.isArray(result.devices) ? result.devices : []);
      setStatus("");
    } catch (error) {
      $("layneGarminDeviceList").replaceChildren();
      setStatus(errorLabel(error), "error");
    }
  };

  $("layneGarminCreateCode")?.addEventListener("click", async () => {
    const button = $("layneGarminCreateCode");
    const output = $("layneGarminPairingCode");
    const deviceName = $("layneGarminDeviceName").value.trim();
    output.hidden = true;
    if (!deviceName) {
      setStatus("Enter a device name first.", "error");
      return;
    }
    button.disabled = true;
    setStatus("Creating a short-lived pairing code…");
    try {
      const result = await ownerRequest("/api/garmin/pairing-codes", {
        method: "POST",
        body: JSON.stringify({ device_name: deviceName }),
      });
      const expiry = new Date(Date.now() + Number(result.expires_in || 300) * 1000)
        .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      output.innerHTML = "Enter this code on your watch: <code>" + escapeHtml(result.code) +
        "</code><small>Expires at " + escapeHtml(expiry) + ". Use it once.</small>";
      output.hidden = false;
      setStatus("Pairing code created. It is shown only in this page session.");
      await loadDevices();
      setStatus("Pairing code created. It is shown only in this page session.");
    } catch (error) {
      setStatus(errorLabel(error), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("layneGarminRefresh")?.addEventListener("click", loadDevices);
  $("layneGarminDeviceList")?.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-transcript-scope]");
    if (!input) return;
    const card = input.closest("[data-device-id]");
    if (!card) return;
    input.disabled = true;
    try {
      await ownerRequest("/api/garmin/devices/" + encodeURIComponent(card.dataset.deviceId) + "/transcripts", {
        method: "POST",
        body: JSON.stringify({ enabled: input.checked }),
      });
      setStatus(input.checked ? "Transcript access enabled for this watch." : "Transcript access disabled.");
      await loadDevices();
    } catch (error) {
      setStatus(errorLabel(error), "error");
      await loadDevices();
    }
  });
  $("layneGarminDeviceList")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-revoke]");
    if (!button) return;
    const card = button.closest("[data-device-id]");
    if (!card) return;
    button.disabled = true;
    try {
      await ownerRequest("/api/garmin/devices/" + encodeURIComponent(card.dataset.deviceId) + "/revoke", {
        method: "POST",
        body: "{}",
      });
      setStatus("Watch access revoked.");
      await loadDevices();
    } catch (error) {
      setStatus(errorLabel(error), "error");
      button.disabled = false;
    }
  });
})();
