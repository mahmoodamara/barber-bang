import pino from "pino";
import { ENV } from "./env.js";

export const logger = pino({
  level: ENV.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers[\"stripe-signature\"]",
      "req.body.password",
      "req.body.token",
      "req.body.refreshToken",
    ],
    remove: true,
  },
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});
