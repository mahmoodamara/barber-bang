// src/services/orderDraft.service.js
import mongoose from "mongoose";
import { Order, Variant, Product, User } from "../models/index.js";
import { reserveStock } from "./stock.service.js";
import { normalizeCurrency, ensureMinorUnitsInt } from "../utils/stripe.js";
import { assertOrderTransition, ORDER_STATUS } from "../utils/orderState.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { repriceOrder } from "./reprice.service.js";

// Phase 8 (Coupons)
import { applyCouponToOrder } from "./coupon.service.js";

// Phase 11 (Shipping)
import { setOrderShippingMethod } from "./shipping.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function toObjectId(id, field = "id") {
  const s = String(id || "").trim();
  if (!/^[a-fA-F0-9]{24}$/.test(s)) throw httpError(400, "INVALID_OBJECT_ID", `${field} invalid`);
  return new mongoose.Types.ObjectId(s);
}

function intMin1(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, "INVALID_QUANTITY", `${field} must be integer >= 1`);
  return n;
}

function ensureMinorInt(v, field) {
  if (!Number.isInteger(v) || v < 0) {
    throw httpError(500, "INVALID_MONEY_UNIT", `${field} must be integer minor units >= 0`);
  }
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function pickAuthForCoupon(userId) {
  // coupon.service expects auth-ish
  return { userId, roles: ["user"] };
}

function normalizeAddressSnapshotInput(a) {
  if (!a || typeof a !== "object") return null;
  const s = (v, max, fallback = "") => {
    const out = String(v ?? "").trim();
    const clipped = out.length > max ? out.slice(0, max) : out;
    return clipped || fallback;
  };
  return {
    fullName: s(a.fullName, 120, ""),
    phone: s(a.phone, 30, ""),
    country: s(a.country, 80, ""),
    city: s(a.city, 120, ""),
    street: s(a.street, 200, ""),
    building: s(a.building, 50, ""),
    apartment: s(a.apartment, 50, ""),
    zip: s(a.zip ?? a.postalCode, 30, ""),
    notes: s(a.notes, 500, ""),
  };
}

/**
 * createDraftOrder (hardened)
 * - merge duplicate variantIds
 * - snapshot product/variant data (sku + names + price)
 * - base pricing computed locally (minor units)
 * - optional: apply coupon (Phase 8) -> reserves redemption safely
 * - optional: set shipping method (Phase 11) -> snapshot + pricing.shipping
 * - reserve stock then switch to pending_payment with TTL
 * - on failure: release stock + release coupon reservation + cancel order safely
 */
export async function createDraftOrder({ userId, lang = "he", body }) {
  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");

  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw httpError(400, "ITEMS_REQUIRED", "Order items are required");

  let shippingAddress = body?.shippingAddress ?? null;
  let billingAddress = body?.billingAddress ?? null;
  const shippingAddressId = body?.shippingAddressId ? String(body.shippingAddressId) : null;
  const billingAddressId = body?.billingAddressId ? String(body.billingAddressId) : null;

  // New additions (optional)
  const shippingMethodId = body?.shippingMethodId ? String(body.shippingMethodId) : null;
  const couponRaw =
    body?.couponCode ||
    (typeof body?.coupon === "string" ? body.coupon : body?.coupon?.code) ||
    "";
  const couponCode = normalizeCode(couponRaw);
  const promoRaw = body?.promotionCode || body?.promoCode || "";
  const promotionCode = normalizeCode(promoRaw);

  // 1) Resolve address snapshots (optional)
  if (shippingAddressId || billingAddressId) {
    const user = await applyQueryBudget(User.findById(userId).select("addresses").lean());
    if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");

    const addrById = (id) =>
      Array.isArray(user.addresses)
        ? user.addresses.find((a) => String(a?._id) === String(id))
        : null;

    const normalizeAddr = (a) => ({
      fullName: a?.fullName || "",
      phone: a?.phone || "",
      country: a?.country || "Israel",
      city: a?.city || "",
      street: a?.street || "",
      building: a?.building || "",
      apartment: a?.apartment || "",
      zip: a?.zip || "",
      notes: a?.notes || "",
    });

    if (shippingAddressId) {
      const found = addrById(shippingAddressId);
      if (!found) throw httpError(404, "ADDRESS_NOT_FOUND", "Shipping address not found");
      shippingAddress = normalizeAddr(found);
    }

    if (billingAddressId) {
      const found = addrById(billingAddressId);
      if (!found) throw httpError(404, "ADDRESS_NOT_FOUND", "Billing address not found");
      billingAddress = normalizeAddr(found);
    }
  }

  // Normalize inline address payloads (do NOT accept tax from client; tax is computed later)
  if (shippingAddress && !shippingAddressId) shippingAddress = normalizeAddressSnapshotInput(shippingAddress);
  if (billingAddress && !billingAddressId) billingAddress = normalizeAddressSnapshotInput(billingAddress);

  // 2) Merge duplicates by variantId (reduce DB + stock ops)
  const byVariant = new Map();
  for (const it of items) {
    const variantId = String(it?.variantId || "").trim();
    const quantity = intMin1(it?.quantity, "items[].quantity");

    if (!variantId) throw httpError(400, "VARIANT_REQUIRED", "items[].variantId is required");
    byVariant.set(variantId, (byVariant.get(variantId) || 0) + quantity);
  }

  const mergedItems = [...byVariant.entries()].map(([variantId, quantity]) => ({
    variantId,
    quantity,
  }));

  const variantObjectIds = mergedItems.map((i) => toObjectId(i.variantId, "variantId"));

  // 2) Load variants (active) + minimal fields
  const variants = await applyQueryBudget(
    Variant.find(
      { _id: { $in: variantObjectIds }, isActive: true, isDeleted: { $ne: true } },
      { _id: 1, productId: 1, sku: 1, price: 1, currency: 1, stock: 1, stockReserved: 1, isActive: 1 },
    ).lean(),
  );

  if (variants.length !== mergedItems.length) {
    throw httpError(400, "VARIANT_NOT_FOUND", "One or more variants not found or inactive");
  }

  // 3) Load products for name snapshots (avoid empty snapshots)
  const productIds = [...new Set(variants.map((v) => String(v.productId)))].map((id) =>
    toObjectId(id, "productId"),
  );

  const products = await applyQueryBudget(
    Product.find(
      { _id: { $in: productIds }, isDeleted: { $ne: true } },
      { _id: 1, nameHe: 1, nameAr: 1, isActive: 1 },
    ).lean(),
  );

  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const vMap = new Map(variants.map((v) => [String(v._id), v]));

  // 4) Build order items + fail-fast stock sanity (best-effort; real enforcement in reserveStock)
  const orderItems = mergedItems.map((i) => {
    const v = vMap.get(String(i.variantId));
    if (!v) throw httpError(400, "VARIANT_NOT_FOUND", "Variant not found");

    const p = pMap.get(String(v.productId)) || null;
    if (!p || p.isActive === false) {
      throw httpError(409, "PRODUCT_INACTIVE", "Product is not active");
    }

    const unitPrice = Number(v.price);
    ensureMinorUnitsInt(unitPrice);
    ensureMinorInt(unitPrice, "variant.price");

    const quantity = intMin1(i.quantity, "items[].quantity");
    const lineTotal = unitPrice * quantity;

    ensureMinorInt(lineTotal, "items[].lineTotal");

    // Soft stock check (optional; reserveStock remains the source of truth)
    if (Number.isInteger(v.stock)) {
      const reserved = Number.isInteger(v.stockReserved) ? v.stockReserved : 0;
      const available = v.stock - reserved;
      if (quantity > available) {
        throw httpError(409, "INSUFFICIENT_STOCK", "Not enough stock", {
          variantId: String(v._id),
          available,
          desiredQty: quantity,
        });
      }
    }

    return {
      variantId: v._id,
      productId: v.productId,

      skuSnapshot: v.sku || "",

      nameHeSnapshot: p?.nameHe || "",
      nameArSnapshot: p?.nameAr || "",

      unitPrice, // minor units
      quantity,
      lineTotal,
    };
  });

  // 5) Base pricing (Order pre-validate will enforce totals too)
  const subtotal = orderItems.reduce((sum, it) => sum + (it.lineTotal || 0), 0);
  ensureMinorInt(subtotal, "pricing.subtotal");

  // Enforce single currency at order level
  const currencies = [
    ...new Set(
      variants
        .map((v) => normalizeCurrency(v.currency) || "ILS")
        .filter(Boolean),
    ),
  ];
  const currency = currencies[0] || "ILS";
  if (currencies.length > 1) {
    throw httpError(409, "CURRENCY_MISMATCH", "Variants have different currencies", { currencies });
  }

  const pricing = {
    currency,
    subtotal,
    discountTotal: 0,
    shipping: 0,
    tax: 0,
    grandTotal: subtotal, // will be recomputed on save if needed
  };

  // TTL (we set it explicitly when switching to pending_payment)
  const ttlMinutes = Number(process.env.ORDER_PAYMENT_TTL_MINUTES || 30);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // Create as draft, apply coupon/shipping, reserve stock, then switch to pending_payment (atomic)
  return await withRequiredTransaction(async (session) => {
    const [order] = await Order.create(
      [
        {
          userId,
          lang: lang === "ar" ? "ar" : "he",
          status: "draft",
          items: orderItems,
          pricing,
          promotionCode: promotionCode || null,
          shippingAddress,
          billingAddress,
          expiresAt, // ok; schema also can auto-set on pending_payment
          stock: { status: "none" },
        },
      ],
      { session },
    );

    // 6) Optional: apply coupon (Phase 8) - reserves redemption safely + updates pricing
    if (couponCode) {
      await applyCouponToOrder({
        orderId: order._id,
        auth: pickAuthForCoupon(userId),
        code: couponCode,
        options: { session },
      });
    }

    // 7) Optional: set shipping method (Phase 11) - snapshot + pricing.shipping + recalculated grandTotal
    if (shippingMethodId) {
      await setOrderShippingMethod({
        orderId: order._id,
        auth: { userId, roles: ["user"] },
        shippingMethodId,
        lang: lang === "ar" ? "ar" : "he",
        options: { session },
      });
    }

    // 7.5) Unified repricing (source of truth) after coupon+shipping snapshots are applied.
    await repriceOrder(order._id, { session });

    // 8) Reserve stock (source of truth against overselling)
    await reserveStock(order._id, orderItems, { session, requireActive: true, expiresAt });

    const fresh = await applyQueryBudget(Order.findById(order._id).session(session));
    if (!fresh) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    assertOrderTransition(fresh.status, ORDER_STATUS.PENDING_PAYMENT);
    fresh.status = ORDER_STATUS.PENDING_PAYMENT;
    fresh.expiresAt = expiresAt;
    fresh.stock = {
      status: "reserved",
      reservedAt: new Date(),
      confirmedAt: null,
      releasedAt: null,
      confirmAttempts: 0,
      lastError: null,
    };

    await fresh.save({ session });
    return fresh.toJSON();
  });
}
