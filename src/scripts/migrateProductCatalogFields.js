import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../config/db.js";
import { Product } from "../models/Product.js";

function extractModelFromText(text) {
  const str = String(text || "");
  const kmMatch = str.match(/\bKM-\d{3,5}\b/i);
  if (kmMatch) return kmMatch[0].toUpperCase();
  const pjMatch = str.match(/\bPJ-\d{2,6}\b/i);
  if (pjMatch) return pjMatch[0].toUpperCase();
  return "";
}

async function main() {
  await connectDB();

  const products = await Product.find(
    {},
    "sku titleHe titleAr title identity classification catalogStatus confidenceGrade verification"
  )
    .sort({ createdAt: 1 })
    .lean();

  if (!products.length) {
    console.log("[migrate-catalog] no products found");
    return;
  }

  let updated = 0;
  let holdCount = 0;
  let unresolved = 0;

  for (const product of products) {
    const set = {};

    const existingModel = String(product.identity?.model || "").trim();
    let model = existingModel;
    if (!model) {
      model =
        extractModelFromText(product.sku) ||
        extractModelFromText(product.titleHe) ||
        extractModelFromText(product.titleAr) ||
        extractModelFromText(product.title);
      if (model) {
        set["identity.model"] = model;
      }
    }

    if (!product.catalogStatus) {
      set.catalogStatus = "HOLD";
    }
    if (!product.confidenceGrade) {
      set.confidenceGrade = "D";
    }

    if (model === "KM-1868") {
      const categoryPrimary = String(product.classification?.categoryPrimary || "").trim();
      if (!categoryPrimary) {
        set["classification.categoryPrimary"] = "Facial Care Device";
      } else if (categoryPrimary !== "Facial Care Device") {
        set["verification.hasCriticalMismatch"] = true;
      }
    }

    if (Object.keys(set).length) {
      await Product.updateOne({ _id: product._id }, { $set: set }).exec();
      updated += 1;
    }

    const effectiveCatalogStatus = set.catalogStatus || product.catalogStatus || "HOLD";
    if (effectiveCatalogStatus === "HOLD") holdCount += 1;

    const effectiveModel = set["identity.model"] || existingModel;
    if (!effectiveModel) unresolved += 1;
  }

  console.log(
    `[migrate-catalog] complete: total=${products.length} updated=${updated} hold=${holdCount} unresolved=${unresolved}`
  );
}

main()
  .catch((err) => {
    console.error("[migrate-catalog] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (err) {
      console.warn("[migrate-catalog] mongoose disconnect failed", String(err?.message || err));
    }
  });
