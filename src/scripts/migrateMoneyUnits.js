import "dotenv/config";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../data/db.js";
import { Variant, ShippingMethod, Coupon, Order, Invoice } from "../models/index.js";
import { toMinorUnits } from "../utils/stripe.js";

const CONFIRM = String(process.env.MIGRATE_MONEY_CONFIRM || "").toUpperCase() === "YES";
const MODE = String(process.env.MIGRATE_MONEY_MODE || "").toLowerCase();

if (!CONFIRM || MODE !== "major_to_minor") {
  throw new Error(
    "Refusing to run. Set MIGRATE_MONEY_CONFIRM=YES and MIGRATE_MONEY_MODE=major_to_minor.",
  );
}

function toMinor(value, currency = "ILS") {
  return toMinorUnits(value, currency);
}

function toMinorNullable(value, currency = "ILS") {
  if (value === null || value === undefined) return null;
  return toMinor(value, currency);
}

async function migrateVariants() {
  const cursor = Variant.find({}).select("_id price currency").cursor();
  const bulk = [];

  for await (const v of cursor) {
    const currency = v.currency || "ILS";
    const priceMinor = toMinor(v.price, currency);
    bulk.push({
      updateOne: { filter: { _id: v._id }, update: { $set: { price: priceMinor, currency } } },
    });
    if (bulk.length >= 500) {
      await Variant.bulkWrite(bulk, { ordered: true });
      bulk.length = 0;
    }
  }
  if (bulk.length) await Variant.bulkWrite(bulk, { ordered: true });
}

async function migrateShippingMethods() {
  const cursor = ShippingMethod.find({}).select("_id basePrice freeAbove minSubtotal maxSubtotal").cursor();
  const bulk = [];

  for await (const m of cursor) {
    bulk.push({
      updateOne: {
        filter: { _id: m._id },
        update: {
          $set: {
            basePrice: toMinor(m.basePrice ?? 0),
            freeAbove: m.freeAbove == null ? null : toMinor(m.freeAbove),
            minSubtotal: m.minSubtotal == null ? null : toMinor(m.minSubtotal),
            maxSubtotal: m.maxSubtotal == null ? null : toMinor(m.maxSubtotal),
          },
        },
      },
    });
    if (bulk.length >= 500) {
      await ShippingMethod.bulkWrite(bulk, { ordered: true });
      bulk.length = 0;
    }
  }
  if (bulk.length) await ShippingMethod.bulkWrite(bulk, { ordered: true });
}

async function migrateCoupons() {
  const cursor = Coupon.find({}).select("_id type value currency minOrderTotal").cursor();
  const bulk = [];

  for await (const c of cursor) {
    const currency = c.currency || "ILS";
    const valueMinor = c.type === "fixed" ? toMinor(c.value, currency) : c.value;
    const minOrderTotal = c.minOrderTotal == null ? 0 : toMinor(c.minOrderTotal, currency);

    bulk.push({
      updateOne: {
        filter: { _id: c._id },
        update: { $set: { value: valueMinor, currency, minOrderTotal } },
      },
    });
    if (bulk.length >= 500) {
      await Coupon.bulkWrite(bulk, { ordered: true });
      bulk.length = 0;
    }
  }
  if (bulk.length) await Coupon.bulkWrite(bulk, { ordered: true });
}

async function migrateOrders() {
  const cursor = Order.find({})
    .select(
      "items pricing coupon shippingMethod payment refund",
    )
    .lean()
    .cursor();
  const bulk = [];

  for await (const o of cursor) {
    const currency =
      o?.pricing?.currency || o?.payment?.currency || o?.shippingMethod?.currency || "ILS";

    const items = Array.isArray(o.items)
      ? o.items.map((it) => ({
          ...it,
          unitPrice: toMinor(it.unitPrice ?? 0, currency),
          lineTotal: toMinor(it.lineTotal ?? 0, currency),
        }))
      : o.items;

    const pricing = o.pricing
      ? {
          ...o.pricing,
          subtotal: toMinor(o.pricing.subtotal ?? 0, currency),
          discountTotal: toMinor(o.pricing.discountTotal ?? 0, currency),
          shipping: toMinor(o.pricing.shipping ?? 0, currency),
          tax: toMinor(o.pricing.tax ?? 0, currency),
          grandTotal: toMinor(o.pricing.grandTotal ?? 0, currency),
          currency,
        }
      : o.pricing;

    const coupon = o.coupon
      ? {
          ...o.coupon,
          discountTotal: toMinor(o.coupon.discountTotal ?? 0, currency),
        }
      : o.coupon;

    const shippingMethod = o.shippingMethod
      ? {
          ...o.shippingMethod,
          basePriceSnapshot: toMinor(o.shippingMethod.basePriceSnapshot ?? 0, currency),
          freeAboveSnapshot: toMinorNullable(o.shippingMethod.freeAboveSnapshot, currency),
          computedPrice: toMinor(o.shippingMethod.computedPrice ?? 0, currency),
        }
      : o.shippingMethod;

    const payment = o.payment
      ? {
          ...o.payment,
          amountCaptured: toMinorNullable(o.payment.amountCaptured, currency),
          checkoutAmount: toMinorNullable(o.payment.checkoutAmount, currency),
          currency: o.payment.currency || currency,
        }
      : o.payment;

    const refund = o.refund
      ? {
          ...o.refund,
          amountRefunded: toMinor(o.refund.amountRefunded ?? 0, currency),
        }
      : o.refund;

    bulk.push({
      updateOne: {
        filter: { _id: o._id },
        update: {
          $set: {
            items,
            pricing,
            coupon,
            shippingMethod,
            payment,
            refund,
          },
        },
      },
    });

    if (bulk.length >= 200) {
      await Order.bulkWrite(bulk, { ordered: true });
      bulk.length = 0;
    }
  }

  if (bulk.length) await Order.bulkWrite(bulk, { ordered: true });
}

async function migrateInvoices() {
  const cursor = Invoice.find({}).select("_id grandTotal currency").cursor();
  const bulk = [];

  for await (const inv of cursor) {
    const currency = inv.currency || "ILS";
    bulk.push({
      updateOne: {
        filter: { _id: inv._id },
        update: { $set: { grandTotal: toMinor(inv.grandTotal ?? 0, currency), currency } },
      },
    });
    if (bulk.length >= 500) {
      await Invoice.bulkWrite(bulk, { ordered: true });
      bulk.length = 0;
    }
  }
  if (bulk.length) await Invoice.bulkWrite(bulk, { ordered: true });
}

async function main() {
  await connectDb();

  await migrateVariants();
  await migrateShippingMethods();
  await migrateCoupons();
  await migrateOrders();
  await migrateInvoices();

  await disconnectDb();
}

main()
  .then(() => {
    mongoose.disconnect().catch(() => {});
  })
  .catch((err) => {
    console.error("Money migration failed:", err);
    mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
