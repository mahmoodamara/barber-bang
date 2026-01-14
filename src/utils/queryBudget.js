import { ENV } from "./env.js";

export function applyQueryBudget(query, maxTimeMs = Number(ENV.QUERY_MAX_TIME_MS || 4000)) {
  if (!ENV.QUERY_BUDGET_ENABLED) return query;
  if (!query) return query;

  if (typeof query.maxTimeMS === "function") {
    query.maxTimeMS(maxTimeMs);
    return query;
  }

  if (typeof query.option === "function") {
    query.option({ maxTimeMS: maxTimeMs });
    return query;
  }

  return query;
}
