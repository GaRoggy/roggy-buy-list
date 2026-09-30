/* Email dashboard monitor only. Agent status and Daily brief UI intentionally removed. */
/*
 * Compatibility bridge for older deployments.
 *
 * Queue rendering now lives in app.js so Dashboard, Finance, and Mail share
 * one bounded query, dismissal state, and animation behavior. Do not poll
 * monitor_records here: the old renderer could reintroduce uncategorized mail
 * into the Dashboard and made an extra request every minute.
 */
(() => {
  window.refreshMonitorUi = () => typeof loadEmailQueues === "function"
    ? loadEmailQueues()
    : Promise.resolve();
})();
