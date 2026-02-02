// src/utils/logger.js

import pino from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.cookies",
  "*.token",
  "*.secret",
  "*.password",
  "*.authorization",
  "*.phone",
  "*.email",
  "*.address",
  "*.card",
  "headers.authorization",
  "headers.cookie",
  "cookies",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
];

const baseOptions = {
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
};

export const log = pino(baseOptions);

/**
 * Returns a child logger bound to the request with requestId only.
 * Route and method are logged at request completion to avoid duplication.
 * Use in routes as req.log (attached in app.js).
 */
export function reqLogger(req) {
  const requestId = req?.requestId || null;
  return log.child({ requestId });
}

export default log;
