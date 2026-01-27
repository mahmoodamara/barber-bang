import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../config/db.js";
import { Product } from "../models/Product.js";
import { generateUniqueSlug } from "../utils/slug.js";

async function main() {
  await connectDB();

  const products = await Product.find({}, "slug titleHe titleAr title").sort({ createdAt: 1 }).lean();
  if (!products.length) {
    console.log("[backfill-slugs] no products found");
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    const baseInput =
      String(product.slug || "").trim() ||
      product.titleHe ||
      product.titleAr ||
      product.title ||
      product._id?.toString() ||
      Date.now().toString();

    const newSlug = await generateUniqueSlug(Product, baseInput, product._id);
    if (String(product.slug || "") === newSlug) {
      skipped += 1;
      continue;
    }

    await Product.updateOne({ _id: product._id }, { $set: { slug: newSlug } }).exec();
    updated += 1;
    console.log(`[backfill-slugs] updated ${product._id} -> ${newSlug}`);
  }

  console.log(
    `[backfill-slugs] complete: total=${products.length} updated=${updated} skipped=${skipped}`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-slugs] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (err) {
      console.warn("[backfill-slugs] mongoose disconnect failed", String(err?.message || err));
    }
  });
