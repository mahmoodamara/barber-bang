/**
 * Backfill Product.reviewsCount + Product.ratingAvg from approved reviews.
 *
 * Usage:
 *   node src/scripts/backfillProductReviewStats.js
 *   DRY_RUN=true node src/scripts/backfillProductReviewStats.js
 *   RESET_ALL=false node src/scripts/backfillProductReviewStats.js
 *   BATCH_SIZE=1000 node src/scripts/backfillProductReviewStats.js
 */

import { connectDb, disconnectDb } from "../data/db.js";
import { logger } from "../utils/logger.js";
import { Review, Product } from "../models/index.js";

const DRY_RUN = String(process.env.DRY_RUN || "false") === "true";
const RAW_BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const BATCH_SIZE = Number.isFinite(RAW_BATCH_SIZE) && RAW_BATCH_SIZE > 0 ? RAW_BATCH_SIZE : 500;
const RESET_ALL = String(process.env.RESET_ALL || "true") !== "false";

async function resetAllStats() {
  if (DRY_RUN) {
    logger.info("DRY_RUN=true: skipping reset of Product review stats");
    return;
  }

  const result = await Product.updateMany({}, { $set: { reviewsCount: 0, ratingAvg: null } });
  const matched = result?.matchedCount ?? result?.n ?? 0;
  const modified = result?.modifiedCount ?? result?.nModified ?? 0;
  logger.info({ matched, modified }, "Reset Product review stats");
}

async function flushBulk(bulk, totals) {
  if (!bulk.length) return;
  totals.attempted += bulk.length;
  if (DRY_RUN) return;
  await Product.bulkWrite(bulk);
}

async function main() {
  await connectDb();
  logger.info(
    { dryRun: DRY_RUN, batchSize: BATCH_SIZE, resetAll: RESET_ALL },
    "Backfill Product review stats starting",
  );

  if (RESET_ALL) await resetAllStats();

  const cursor = Review.aggregate([
    { $match: { status: "approved", isDeleted: false } },
    {
      $group: {
        _id: "$productId",
        reviewsCount: { $sum: 1 },
        ratingAvg: { $avg: "$rating" },
      },
    },
  ])
    .allowDiskUse(true)
    .cursor({ batchSize: BATCH_SIZE });

  const totals = { attempted: 0 };
  let bulk = [];

  for await (const row of cursor) {
    if (!row?._id) continue;
    bulk.push({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            reviewsCount: row.reviewsCount || 0,
            ratingAvg: row.ratingAvg ?? null,
          },
        },
      },
    });

    if (bulk.length >= BATCH_SIZE) {
      await flushBulk(bulk, totals);
      logger.info({ attempted: totals.attempted }, "Backfill progress");
      bulk = [];
    }
  }

  await flushBulk(bulk, totals);
  logger.info({ attempted: totals.attempted, dryRun: DRY_RUN }, "Backfill complete");
  await disconnectDb();
}

main().catch(async (err) => {
  logger.fatal({ err }, "Backfill Product review stats failed");
  try {
    await disconnectDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
