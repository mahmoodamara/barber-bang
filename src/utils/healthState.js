let unhealthy = false;
let reason = null;

export function markUnhealthy(r) {
  unhealthy = true;
  reason = r || "unknown";
}

export function markHealthy() {
  unhealthy = false;
  reason = null;
}

export function isHealthy() {
  return !unhealthy;
}

export function getUnhealthyReason() {
  return reason;
}
