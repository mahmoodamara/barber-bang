import mongoose from "mongoose";
import { ENV } from "./env.js";
import { logger } from "./logger.js";
import {
  dbQueryDurationMs,
  dbQueryTimeoutsTotal,
  dbSlowQueriesTotal,
} from "../observability/prom.js";

let installed = false;

const READ_OPS = new Set([
  "find",
  "findOne",
  "count",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
]);

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxTimeMs() {
  return toPositiveInt(ENV.QUERY_MAX_TIME_MS, 4000);
}

function slowQueryMs() {
  return toPositiveInt(ENV.DB_SLOW_QUERY_MS || ENV.SLOW_REQUEST_MS, 1000);
}

function isTimeoutError(err) {
  const code = Number(err?.code || 0);
  const codeName = String(err?.codeName || "");
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  return (
    code === 50 ||
    codeName === "MaxTimeMSExpired" ||
    name.includes("MongoServerError") && msg.includes("maxTimeMS") ||
    msg.includes("MaxTimeMSExpired") ||
    msg.includes("maxTimeMS")
  );
}

function recordQuery({ op, collection, ms, status, maxTimeMS }) {
  try {
    dbQueryDurationMs.labels(op, collection, status).observe(ms);
    if (status === "timeout") dbQueryTimeoutsTotal.labels(op, collection).inc();
    if (ms >= slowQueryMs()) {
      dbSlowQueriesTotal.labels(op, collection).inc();
      logger.warn({ op, collection, ms, maxTimeMS }, "Slow query");
    }
  } catch {
    // ignore metrics/logging failures
  }
}

function applyMaxTimeIfMissing(query, op) {
  if (!ENV.QUERY_BUDGET_ENABLED) return;
  if (op && !READ_OPS.has(op)) return;
  if (query?.options?.maxTimeMS) return;
  if (typeof query?.maxTimeMS === "function") {
    query.maxTimeMS(maxTimeMs());
  }
}

export function installMongooseMonitoring() {
  if (installed) return;
  installed = true;

  const origExec = mongoose.Query.prototype.exec;
  mongoose.Query.prototype.exec = async function patchedExec(...args) {
    const op = String(this?.op || "unknown");
    const collection =
      this?.mongooseCollection?.name ||
      this?.model?.collection?.name ||
      this?.model?.modelName ||
      "unknown";

    applyMaxTimeIfMissing(this, op);
    const appliedMaxTimeMS = this?.options?.maxTimeMS;

    const start = process.hrtime.bigint();
    try {
      const res = await origExec.apply(this, args);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      recordQuery({ op, collection, ms, status: "ok", maxTimeMS: appliedMaxTimeMS });
      return res;
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const timedOut = isTimeoutError(err);
      recordQuery({
        op,
        collection,
        ms,
        status: timedOut ? "timeout" : "error",
        maxTimeMS: appliedMaxTimeMS,
      });
      throw err;
    }
  };

  const origAggExec = mongoose.Aggregate.prototype.exec;
  mongoose.Aggregate.prototype.exec = async function patchedAggExec(...args) {
    const collection = this?._model?.collection?.name || this?._model?.modelName || "unknown";
    const op = "aggregate";

    if (ENV.QUERY_BUDGET_ENABLED && !this?.options?.maxTimeMS) {
      if (typeof this?.option === "function") {
        this.option({ maxTimeMS: maxTimeMs() });
      }
    }
    const appliedMaxTimeMS = this?.options?.maxTimeMS;

    const start = process.hrtime.bigint();
    try {
      const res = await origAggExec.apply(this, args);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      recordQuery({ op, collection, ms, status: "ok", maxTimeMS: appliedMaxTimeMS });
      return res;
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const timedOut = isTimeoutError(err);
      recordQuery({
        op,
        collection,
        ms,
        status: timedOut ? "timeout" : "error",
        maxTimeMS: appliedMaxTimeMS,
      });
      throw err;
    }
  };
}
