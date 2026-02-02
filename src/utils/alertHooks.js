// src/utils/alertHooks.js — Alert hooks for webhook failures, checkout failures, refund spikes.
// Log structured events; can be extended to call webhook URL or event bus for external alerts.

import { log } from "./logger.js";

/**
 * Called when a Stripe webhook event fails (signature, amount verification, reservation, etc.).
 * Logs structured event for operational visibility; Prometheus webhook_events_total{status="error"} is incremented separately.
 */
export function onWebhookFailure({ requestId, type, status, reason }) {
  log.warn(
    { requestId, type, status, reason, hook: "webhook_failure" },
    "[alert] Webhook failure"
  );
}

/**
 * Called when a checkout request fails (cart empty, reservation invalid, coupon failed, etc.).
 * Logs structured event; Prometheus checkout_failures_total is incremented separately.
 */
export function onCheckoutFailure(code, requestId) {
  log.warn(
    { requestId, code, hook: "checkout_failure" },
    "[alert] Checkout failure"
  );
}
