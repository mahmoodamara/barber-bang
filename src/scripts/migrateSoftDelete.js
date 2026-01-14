import { connectDb, disconnectDb } from "../data/db.js";
import { logger } from "../utils/logger.js";
import { Category, Product, Variant } from "../models/index.js";

const DRY_RUN = String(process.env.DRY_RUN || "false") === "true";

async function backfill(model, name) {
  if (DRY_RUN) {
    const missing = await model.countDocuments({ isDeleted: { $exists: false } });
    const missingDeletedAt = await model.countDocuments({ isDeleted: true, deletedAt: null });
    logger.info({ model: name, missing, missingDeletedAt }, "Soft-delete backfill (dry run)");
    return;
  }

  const setResult = await model.updateMany(
    { isDeleted: { $exists: false } },
    { $set: { isDeleted: false, deletedAt: null } },
  );

  const fixDeletedAt = await model.updateMany(
    { isDeleted: true, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  );

  const matched = setResult?.matchedCount ?? setResult?.n ?? 0;
  const modified = setResult?.modifiedCount ?? setResult?.nModified ?? 0;
  const fixed = fixDeletedAt?.modifiedCount ?? fixDeletedAt?.nModified ?? 0;

  logger.info(
    { model: name, matched, modified, fixedDeletedAt: fixed },
    "Soft-delete backfill complete",
  );
}

async function main() {
  await connectDb();
  logger.info({ dryRun: DRY_RUN }, "Soft-delete migration starting");

  await backfill(Category, "Category");
  await backfill(Product, "Product");
  await backfill(Variant, "Variant");

  await disconnectDb();
  logger.info("Soft-delete migration finished");
}

main().catch(async (err) => {
  logger.fatal({ err }, "Soft-delete migration failed");
  try {
    await disconnectDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
