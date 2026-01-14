import { ENV } from "../utils/env.js";

export function queryBudget(req, _res, next) {
  req.budgets = {
    maxTimeMs: Number(ENV.QUERY_MAX_TIME_MS || 4000),
    slowRequestMs: Number(ENV.SLOW_REQUEST_MS || 1200),
  };
  next();
}
