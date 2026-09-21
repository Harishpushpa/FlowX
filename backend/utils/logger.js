export function logEvent(level, event, fields = {}) {
  const payload = { timestamp: new Date().toISOString(), level, event, ...fields };
  console[level === "error" ? "error" : "log"](JSON.stringify(payload));
}
