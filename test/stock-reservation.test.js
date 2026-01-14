import test from "node:test";
import assert from "node:assert/strict";

const runDbTests = String(process.env.RUN_DB_TESTS || "").toLowerCase() === "true";
const mongoUri =
  process.env.MONGO_TEST_URI ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  "";

const skipReason = !runDbTests
  ? "RUN_DB_TESTS=true required"
  : !mongoUri
    ? "MONGO_URI (or MONGO_TEST_URI) required"
    : null;

function ensureTestEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_1234567890";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_dummy";
  process.env.MONGO_URI = mongoUri;
  process.env.MONGO_DB_NAME =
    process.env.MONGO_DB_NAME || `barber_store_test_${Date.now()}`;
}

test("stock reservation is atomic and idempotent", { skip: skipReason }, async () => {
  ensureTestEnv();

  const mongoose = (await import("mongoose")).default;
  const { connectDb, disconnectDb } = await import("../src/data/db.js");
  const { Product, Variant, StockReservation, StockLog } = await import("../src/models/index.js");
  const {
    reserveStock,
    confirmStock,
    releaseReservedStockBulk,
  } = await import("../src/services/stock.service.js");

  await connectDb();

  const order1 = new mongoose.Types.ObjectId();
  const order2 = new mongoose.Types.ObjectId();
  const sku = `test-sku-${Date.now()}`;

  let product;
  let variant;

  try {
    product = await Product.create({
      nameHe: "Test Product",
      nameAr: "Test Product",
      isActive: true,
      isDeleted: false,
      inStock: false,
    });

    variant = await Variant.create({
      productId: product._id,
      sku,
      price: 1000,
      currency: "ILS",
      stock: 3,
      stockReserved: 0,
      isActive: true,
      isDeleted: false,
    });

    const items = [{ variantId: variant._id, productId: product._id, quantity: 3 }];

    const results = await Promise.allSettled([
      reserveStock(order1, items),
      reserveStock(order2, items),
    ]);

    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const errCount = results.filter((r) => r.status === "rejected").length;
    assert.equal(okCount, 1);
    assert.equal(errCount, 1);

    const afterReserve = await Variant.findById(variant._id).lean();
    assert.equal(afterReserve.stockReserved, 3);

    const productAfterReserve = await Product.findById(product._id).lean();
    assert.equal(productAfterReserve.inStock, false);

    await confirmStock(order1, items, { allowLegacy: true });
    const afterConfirm = await Variant.findById(variant._id).lean();
    assert.equal(afterConfirm.stock, 0);
    assert.equal(afterConfirm.stockReserved, 0);

    await confirmStock(order1, items, { allowLegacy: true });
    const afterConfirmTwice = await Variant.findById(variant._id).lean();
    assert.equal(afterConfirmTwice.stock, 0);
    assert.equal(afterConfirmTwice.stockReserved, 0);

    await Variant.updateOne({ _id: variant._id }, { $inc: { stockReserved: 2 } });
    await releaseReservedStockBulk(order2, [{ variantId: variant._id, productId: product._id, quantity: 2 }], {
      allowLegacy: true,
      requireActive: false,
      reason: "test_release",
    });

    const afterRelease = await Variant.findById(variant._id).lean();
    assert.equal(afterRelease.stockReserved, 0);
  } finally {
    if (variant?._id) {
      await Variant.deleteOne({ _id: variant._id });
      await StockLog.deleteMany({ variantId: variant._id });
    }
    if (product?._id) {
      await Product.deleteOne({ _id: product._id });
    }
    await StockReservation.deleteMany({ orderId: { $in: [order1, order2] } });
    await disconnectDb();
  }
});
