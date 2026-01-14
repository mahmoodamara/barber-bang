import { logger } from "../utils/logger.js";
import { ENV } from "../utils/env.js";

export function slowRequestLog(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms >= ENV.SLOW_REQUEST_MS) {
      logger.warn(
        {
          ms,
          path: req.path,
          method: req.method,
          statusCode: res.statusCode,
          requestId: req.requestId,
        },
        "Slow request",
      );
    }
  });

  next();
}
