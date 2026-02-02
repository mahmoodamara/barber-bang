// src/utils/sentry.js
/**
 * Optional Sentry integration. Set SENTRY_DSN to enable.
 * No PII sent; requestId and minimal context only.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

let Sentry = null;

function loadSentry() {
  if (Sentry) return Sentry;
  try {
    Sentry = require("@sentry/node");
  } catch {
    return null;
  }
  return Sentry;
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || typeof dsn !== "string" || !dsn.trim()) return;

  const S = loadSentry();
  if (!S) return;

  S.init({
    dsn: dsn.trim(),
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    maxBreadcrumbs: 50,
    beforeSend(event, hint) {
      const err = hint?.originalException;
      if (event.request) {
        event.request.headers = event.request.headers || {};
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      if (event.extra) {
        delete event.extra.body;
        delete event.extra.password;
      }
      return event;
    },
  });
}

export function captureException(err, context = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || !dsn.trim()) return;

  const S = loadSentry();
  if (!S) return;

  const { requestId, ...rest } = context;
  S.withScope((scope) => {
    if (requestId) scope.setTag("requestId", String(requestId));
    Object.entries(rest).forEach(([k, v]) => {
      if (k !== "password" && k !== "token" && k !== "authorization") {
        scope.setExtra(k, v);
      }
    });
    S.captureException(err);
  });
}
