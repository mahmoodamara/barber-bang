/**
 * src/scripts/ensureIndexes.js — Phase 6 hardened (ESM)
 *
 * What’s improved vs your current version:
 * - Robust import style: namespace import (* as Models) so missing exports won't crash startup
 * - Supports Phase 0–6 models (including Phase 6: RateLimitBucket/IdempotencyRecord/LeaseLock)
 * - Stable, deterministic order + optional include/exclude filters
 * - Better conflict detection for index option/key conflicts + duplicate key during unique builds
 * - Optional "validate only" mode (DRY_RUN) to inspect current indexes
 * - Safe continue-on-error behavior per model
 *
 * Usage:
 *   node src/scripts/ensureIndexes.js
 *   DRY_RUN=true node src/scripts/ensureIndexes.js
 *   CONTINUE_ON_ERROR=true node src/scripts/ensureIndexes.js
 *   INDEX_BUILD_MAX_TIME_MS=120000 node src/scripts/ensureIndexes.js
 *   ONLY=User,Product node src/scripts/ensureIndexes.js
 *   SKIP=AuditLog,AlertLog node src/scripts/ensureIndexes.js
 */

import { connectDb, disconnectDb } from "../data/db.js";
import { logger } from "../utils/logger.js";

// IMPORTANT: namespace import prevents "does not provide export named X" crashes
import * as Models from "../models/index.js";

const DRY_RUN = String(process.env.DRY_RUN || "false") === "true";
const CONTINUE_ON_ERROR = String(process.env.CONTINUE_ON_ERROR || "false") === "true";
const INDEX_BUILD_MAX_TIME_MS = Number(process.env.INDEX_BUILD_MAX_TIME_MS || 120_000);

// Optional filters
const ONLY = String(process.env.ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SKIP = new Set(
  String(process.env.SKIP || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function isIndexConflict(err) {
  const code = Number(err?.code || 0);
  const msg = String(err?.message || "");

  return (
    code === 85 || // IndexOptionsConflict
    code === 86 || // IndexKeySpecsConflict
    code === 11000 || // duplicate key error (unique index build)
    msg.includes("IndexOptionsConflict") ||
    msg.includes("IndexKeySpecsConflict") ||
    msg.includes("already exists") ||
    msg.includes("equivalent index already exists") ||
    msg.includes("E11000 duplicate key error") ||
    msg.includes("duplicate key error") ||
    msg.includes("An existing index has the same name") ||
    msg.includes("cannot create index") ||
    msg.includes("ConflictingIndexOptions")
  );
}

function pickModelByName(name) {
  if (SKIP.has(name)) {
    logger.info({ model: name }, "Skipping model (SKIP)");
    return null;
  }

  if (ONLY.length && !ONLY.includes(name)) return null;

  const M = Models[name];
  if (!M) {
    logger.warn({ model: name }, "Model export missing in src/models/index.js — skipping");
    return null;
  }

  // Basic sanity: ensure it looks like a mongoose model
  if (!M.modelName || !M.collection || typeof M.syncIndexes !== "function") {
    logger.warn({ model: name }, "Export found but is not a mongoose model — skipping");
    return null;
  }

  return M;
}

async function syncModelIndexes(M) {
  const model = M?.modelName || "UnknownModel";
  logger.info({ model, dryRun: DRY_RUN, maxTimeMS: INDEX_BUILD_MAX_TIME_MS }, "Syncing indexes...");

  if (DRY_RUN) {
    // Inspect only
    try {
      const current = await M.collection.indexes();
      logger.info(
        {
          model,
          indexes: current.map((i) => ({
            name: i.name,
            key: i.key,
            unique: i.unique,
            sparse: i.sparse,
            partialFilterExpression: i.partialFilterExpression,
            expireAfterSeconds: i.expireAfterSeconds,
          })),
        },
        "Current indexes",
      );
    } catch (e) {
      logger.warn({ model, err: e }, "Unable to read current indexes (dry run)");
    }
    return;
  }

  // Real sync
  await M.syncIndexes({ maxTimeMS: INDEX_BUILD_MAX_TIME_MS });
  logger.info({ model }, "Indexes synced");
}

async function main() {
  await connectDb();

  // Deterministic order (Phase 0–6).
  // Add/remove here if your project adds new models later.
  const modelNames = [
    // Core
    "User",
    "Category",
    "Product",
    "Variant",
    "Order",
    "Coupon",
    "CouponRedemption",
    "CouponUserUsage",
    "Promotion",
    "PromotionRedemption",
    "PromotionUserUsage",
    "StockLog",
    "StockReservation",
    "StripeEvent",
    "Invoice",
    "Job",

    // Ops/Logs
    "AuditLog",
    "AlertLog",

    // Domain extras
    "RefundRequest",

    // Phase 5
    "FeatureFlag",
    "ReadModel",

    // Phase 6
    "RateLimitBucket",
    "IdempotencyRecord",
    "LeaseLock",
  ];

  const models = modelNames.map(pickModelByName).filter(Boolean);

  logger.info(
    {
      count: models.length,
      models: models.map((m) => m.modelName),
      dryRun: DRY_RUN,
      continueOnError: CONTINUE_ON_ERROR,
      only: ONLY.length ? ONLY : undefined,
      skip: SKIP.size ? Array.from(SKIP) : undefined,
    },
    "ensureIndexes starting",
  );

  for (const M of models) {
    try {
      await syncModelIndexes(M);
    } catch (err) {
      const model = M?.modelName || "UnknownModel";

      if (isIndexConflict(err)) {
        logger.warn(
          { model, code: err?.code, message: err?.message },
          "Index conflict detected — leaving existing index as-is",
        );
        if (CONTINUE_ON_ERROR) continue;
        throw err;
      }

      logger.error({ model, err }, "Index sync failed");
      if (CONTINUE_ON_ERROR) continue;
      throw err;
    }
  }

  logger.info({ models: models.map((m) => m.modelName) }, "All indexes ensured successfully");
  await disconnectDb();
}

main().catch(async (err) => {
  logger.fatal({ err }, "ensureIndexes failed");
  try {
    await disconnectDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
