import "dotenv/config";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../data/db.js";
import { Product, Variant } from "../models/index.js";

async function backfillProductsInStock() {
  const productIds = await Product.find({ isDeleted: { $ne: true } }).select("_id").lean();
  const ids = productIds.map((p) => p._id);
  if (!ids.length) return;

  const agg = await Variant.aggregate([
    {
      $match: {
        productId: { $in: ids },
        isActive: true,
        isDeleted: { $ne: true },
      },
    },
    {
      $project: {
        productId: 1,
        available: { $subtract: ["$stock", "$stockReserved"] },
      },
    },
    {
      $group: {
        _id: "$productId",
        anyAvailable: {
          $max: { $cond: [{ $gt: ["$available", 0] }, 1, 0] },
        },
      },
    },
  ]);

  const byId = new Map(agg.map((r) => [String(r._id), r.anyAvailable === 1]));

  const bulk = ids.map((id) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { inStock: byId.get(String(id)) === true } },
    },
  }));

  await Product.bulkWrite(bulk, { ordered: true });
}

async function main() {
  await connectDb();
  await backfillProductsInStock();
  await disconnectDb();
}

main()
  .then(() => {
    mongoose.disconnect().catch(() => {});
  })
  .catch((err) => {
    console.error("Backfill product inStock failed:", err);
    mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
