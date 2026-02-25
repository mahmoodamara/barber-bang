// src/routes/checkout.routes.js

import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";

import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { Counter } from "../models/Counter.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { GuestCart } from "../models/GuestCart.js";

import {
  quotePricing,
  consumeCouponAtomic,
  reserveCouponAtomic,
  releaseCouponReservation,
} from "../services/pricing.service.js";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
} from "../services/stripe.service.js";
import { withMongoTransaction } from "../utils/withMongoTransaction.js";
import { toMinorUnits } from "../utils/stripe.js";
import { evaluateTierProgression } from "../services/tierProgression.service.js";
import {
  reserveStockForOrder,
  confirmStockReservation,
  releaseStockReservation,
  releaseExpiredReservations,
} from "../services/products.service.js";
import { sendOrderConfirmationSafe } from "../services/email.service.js";
import { getRequestId } from "../middleware/error.js";
import { getCheckoutFailureCounter } from "../middleware/prometheus.js";
import { onCheckoutFailure } from "../utils/alertHooks.js";
import { setPrivateNoStore } from "../utils/response.js";
import {
  getGuestCartIdFromRequest,
  getOrCreateGuestCart,
} from "../services/guestCart.service.js";

const router = express.Router();

// ✅ Performance: Checkout responses are always private/personalized
router.use((req, res, next) => {
  setPrivateNoStore(res);
  next();
});

/* ============================
   Zod Schemas
============================ */

const addressSchema = z.object({
  fullName: z.string().min(2).max(80),
  phone: z.string().min(7).max(30),
  city: z.string().min(2).max(60),
  street: z.string().min(2).max(120),
  // Extended address fields (optional) - Issue #3 fix
  building: z.string().max(120).optional(),
  floor: z.string().max(120).optional(),
  apartment: z.string().max(120).optional(),
  entrance: z.string().max(120).optional(),
  // Notes field
  notes: z.string().max(300).optional(),
});

const guestContactSchema = z.object({
  fullName: z.string().min(2).max(80),
  phone: z.string().min(7).max(30),
  email: z.string().email().max(160),
});

const baseCheckoutBodySchema = z
  .object({
    shippingMode: z.enum(["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"]),
    deliveryAreaId: z.string().min(1).optional(),
    pickupPointId: z.string().min(1).optional(),
    address: addressSchema.optional(),
    couponCode: z.string().max(40).optional(),
    guestContact: guestContactSchema.optional(),
    poNumber: z.string().max(100).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.shippingMode === "DELIVERY") {
      if (!b.deliveryAreaId) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryAreaId"],
          message: "deliveryAreaId is required for DELIVERY",
        });
      }
      if (!b.address) {
        ctx.addIssue({
          code: "custom",
          path: ["address"],
          message: "address is required for DELIVERY",
        });
      }
      return;
    }

    if (b.shippingMode === "PICKUP_POINT") {
      if (!b.pickupPointId) {
        ctx.addIssue({
          code: "custom",
          path: ["pickupPointId"],
          message: "pickupPointId is required for PICKUP_POINT",
        });
      }
      return;
    }

    // STORE_PICKUP: no additional requirements
  });

const quoteSchema = z.object({
  body: baseCheckoutBodySchema,
});

/* ============================
   Error helpers (consistent envelope)
============================ */

function makeErr(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const checkoutFailuresTotal = getCheckoutFailureCounter();

function jsonErr(res, e) {
  const req = res.req;
  const code = e?.code || "INTERNAL_ERROR";
  const url = req?.originalUrl || req?.url || "";
  if (String(url).includes("checkout")) {
    checkoutFailuresTotal.inc({ code });
    onCheckoutFailure(code, getRequestId(req));
  }
  return res.status(e?.statusCode || 500).json({
    ok: false,
    error: {
      code,
      message: e?.message || "Unexpected error",
      requestId: getRequestId(req),
      path: url,
      ...(e?.details ? { details: e.details } : {}),
    },
  });
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function calcDiscountTotal(quote) {
  const c = Number(quote?.discounts?.coupon?.amount || 0);
  const ca = Number(quote?.discounts?.campaign?.amount || 0);
  const o = Number(quote?.discounts?.offer?.amount || 0);
  return roundMoney(c + ca + o);
}

function getCouponReservationExpiry() {
  const ttl = Number(process.env.COUPON_RESERVATION_TTL_MINUTES || 15);
  const minutes = Number.isFinite(ttl) && ttl > 0 ? ttl : 15;
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function getNextOrderNumber(session = null) {
  const year = new Date().getFullYear();
  const key = "order";

  const counter = await Counter.findOneAndUpdate(
    { key, year },
    { $inc: { seq: 1 } },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    },
  );

  const seq = Number(counter?.seq || 0);
  const padded = String(Math.max(0, seq)).padStart(6, "0");
  return `BB-${year}-${padded}`;
}

/* ============================
   Cart / Shipping helpers
============================ */

/**
 * Clean invalid cart items (deleted/inactive products, deleted variants) before checkout.
 * Prevents ghost items and ensures quote uses only valid cart data.
 */
async function cleanupCartInvalidItems(userId) {
  const user = await User.findById(userId).populate("cart.productId");
  if (!user || !user.cart?.length) return;

  const keep = [];
  for (const ci of user.cart) {
    const p = ci.productId;
    if (!p || !p._id || p.isActive === false || p.isDeleted === true) continue;
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const variantIdStr = String(ci.variantId || "");
    const variant = hasVariants
      ? p.variants.find((v) => String(v?._id || "") === variantIdStr)
      : null;
    if (hasVariants && variantIdStr && !variant) continue;
    keep.push(ci);
  }

  if (keep.length !== (user.cart || []).length) {
    await User.updateOne({ _id: userId }, { $set: { cart: keep } }).catch(
      () => {},
    );
  }
}

async function getCartItemsOrThrow(userId) {
  await cleanupCartInvalidItems(userId);

  const user = await User.findById(userId).select("cart").lean();
  if (!user) throw makeErr(401, "UNAUTHORIZED", "User not found");

  const cart = user?.cart || [];
  const items = cart
    .map((x) => ({
      productId: x.productId?.toString?.() || String(x.productId || ""),
      qty: Math.max(1, Math.min(999, Number(x.qty || 1))),
      variantId: String(x.variantId || ""),
    }))
    .filter((x) => x.productId);

  if (!items.length) throw makeErr(400, "CART_EMPTY", "Cart is empty");
  return items;
}

async function getGuestCartItemsOrThrow(req) {
  const cartId = getGuestCartIdFromRequest(req);
  const result = await getOrCreateGuestCart(cartId);
  if (!result?.cart?.items?.length)
    throw makeErr(400, "CART_EMPTY", "Cart is empty");

  const items = (result.cart.items || [])
    .map((x) => ({
      productId: x.productId?.toString?.() || String(x.productId || ""),
      qty: Math.max(1, Math.min(999, Number(x.qty || 1))),
      variantId: String(x.variantId || ""),
    }))
    .filter((x) => x.productId);

  if (!items.length) throw makeErr(400, "CART_EMPTY", "Cart is empty");
  return { items, guestCartId: String(result.cartId || "") };
}

/**
 * Clear only purchased items from user cart (safer than cart = [])
 * Prevents deleting items user added AFTER starting checkout.
 * ✅ Considers variantId to correctly handle variant products
 */
async function clearPurchasedItemsFromCart(userId, orderItems, session = null) {
  if (!orderItems?.length) return;

  // Build list of { productId, variantId } pairs from order
  const purchasedItems = (orderItems || [])
    .filter((x) => x?.productId)
    .map((x) => ({
      productId: String(x.productId),
      variantId: String(x.variantId || ""),
    }));

  if (!purchasedItems.length) return;

  // Get user's current cart
  const user = await User.findById(userId).select("cart");
  if (!user || !user.cart?.length) return;

  // Filter out purchased items (match both productId AND variantId)
  const newCart = user.cart.filter((cartItem) => {
    const cartProductId = String(cartItem.productId);
    const cartVariantId = String(cartItem.variantId || "");

    // Keep item if it's NOT in the purchased list
    return !purchasedItems.some(
      (p) => p.productId === cartProductId && p.variantId === cartVariantId,
    );
  });

  // Only update if cart changed
  if (newCart.length !== user.cart.length) {
    await User.updateOne(
      { _id: userId },
      { $set: { cart: newCart } },
      session ? { session } : {},
    );
  }
}

async function clearPurchasedItemsFromGuestCart(
  guestCartId,
  orderItems,
  session = null,
) {
  if (!guestCartId || !orderItems?.length) return;
  const cart = await GuestCart.findOne({ cartId: guestCartId }).select("items");
  if (!cart || !cart.items?.length) return;

  const purchasedItems = (orderItems || [])
    .filter((x) => x?.productId)
    .map((x) => ({
      productId: String(x.productId),
      variantId: String(x.variantId || ""),
    }));
  if (!purchasedItems.length) return;

  cart.items = cart.items.filter((cartItem) => {
    const cartProductId = String(cartItem.productId);
    const cartVariantId = String(cartItem.variantId || "");
    return !purchasedItems.some(
      (p) => p.productId === cartProductId && p.variantId === cartVariantId,
    );
  });

  await cart.save(session ? { session } : undefined);
}

function normalizeGuestContact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fullName = String(raw.fullName || "").trim();
  const phone = String(raw.phone || "").trim();
  const email = String(raw.email || "")
    .trim()
    .toLowerCase();
  if (!fullName || !phone || !email) return null;
  return { fullName, phone, email };
}

async function getOrCreateCheckoutUserFromGuestContact(guestContact) {
  const normalized = normalizeGuestContact(guestContact);
  if (!normalized) {
    throw makeErr(
      400,
      "GUEST_CONTACT_REQUIRED",
      "Guest contact details are required",
    );
  }

  const existing = await User.findOne({ email: normalized.email }).select(
    "_id name email role tokenVersion isBlocked permissions",
  );
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(randomUUID(), 10);
  try {
    const created = await User.create({
      name: normalized.fullName,
      email: normalized.email,
      passwordHash,
    });
    return created;
  } catch (e) {
    if (e?.code === 11000) {
      const raceWinner = await User.findOne({ email: normalized.email }).select(
        "_id name email role tokenVersion isBlocked permissions",
      );
      if (raceWinner) return raceWinner;
    }
    throw e;
  }
}

/**
 * IMPORTANT:
 * Order model shipping.address is an object, NOT nullable.
 * So we always send an address object with safe defaults,
 * even for pickup/store pickup.
 * ✅ Issue #3 fix: Include extended address fields
 */
function toShippingInput(body) {
  const a = body.address || null;
  const g = normalizeGuestContact(body.guestContact);

  const safeAddress = {
    fullName: String(a?.fullName || g?.fullName || ""),
    phone: String(a?.phone || g?.phone || ""),
    city: String(a?.city || ""),
    street: String(a?.street || ""),
    // Extended address fields (safe storage) - Issue #3 fix
    building: String(a?.building || ""),
    floor: String(a?.floor || ""),
    apartment: String(a?.apartment || ""),
    entrance: String(a?.entrance || ""),
    // Notes
    notes: String(a?.notes || ""),
  };

  const phone = safeAddress.phone || "";

  return {
    mode: body.shippingMode,
    deliveryAreaId: body.deliveryAreaId || null,
    pickupPointId: body.pickupPointId || null,

    // keep phone in both root + address for tracking
    phone,
    address: safeAddress,
  };
}

async function attachShippingSnapshots(shipping) {
  const mode = shipping?.mode;
  const base = {
    ...shipping,
    deliveryAreaName: "",
    pickupPointName: "",
    pickupPointAddress: "",
  };

  if (mode === "DELIVERY") {
    const id = shipping?.deliveryAreaId;
    if (!id || !isValidObjectId(id)) {
      throw makeErr(400, "INVALID_DELIVERY_AREA", "Delivery area not found");
    }
    const area = await DeliveryArea.findById(id).lean();
    if (!area || !area.isActive) {
      throw makeErr(400, "INVALID_DELIVERY_AREA", "Delivery area not found");
    }
    base.deliveryAreaName = area.nameHe || area.name || area.nameAr || "";
    return base;
  }

  if (mode === "PICKUP_POINT") {
    const id = shipping?.pickupPointId;
    if (!id || !isValidObjectId(id)) {
      throw makeErr(400, "INVALID_PICKUP_POINT", "Pickup point not found");
    }
    const point = await PickupPoint.findById(id).lean();
    if (!point || !point.isActive) {
      throw makeErr(400, "INVALID_PICKUP_POINT", "Pickup point not found");
    }
    base.pickupPointName = point.nameHe || point.name || point.nameAr || "";
    base.pickupPointAddress =
      point.addressHe || point.address || point.addressAr || "";
    return base;
  }

  if (mode === "STORE_PICKUP") {
    return base;
  }

  throw makeErr(400, "INVALID_SHIPPING_MODE", "Invalid shipping mode");
}

/* ============================
   Quote -> Order mapping
============================ */

function mapOrderItemsFromQuote(quote) {
  return (quote.items || []).map((it) => ({
    productId: it.productId,

    titleHe: String(it.titleHe || ""),
    titleAr: String(it.titleAr || ""),
    title: String(it.titleHe || it.titleAr || ""),

    unitPrice: Number(it.unitPrice || 0),
    qty: Math.max(1, Math.min(999, Number(it.qty || 1))),

    categoryId: it.categoryId || null,

    variantId: String(it.variantId || ""),
    variantSnapshot: it.variantSnapshot || null,
  }));
}

function mapGiftItemsFromQuote(quote) {
  return (quote.gifts || [])
    .filter((g) => g?.productId)
    .map((g) => ({
      productId: g.productId,

      titleHe: String(g.titleHe || ""),
      titleAr: String(g.titleAr || ""),
      title: String(g.titleHe || g.titleAr || ""),

      qty: Math.max(1, Math.min(50, Number(g.qty || 1))),

      // ✅ Include variantId for gift stock reservation (nullable for consistency)
      variantId: g.variantId || null,

      // ✅ Issue #4 fix: Include source for gift DTO stability
      source: g.source || "unknown",
    }));
}

/**
 * ✅ Combine cart items + gifts for unified stock reservation
 * Gifts use the same reservation flow as normal items
 */
function buildReservationItems(quoteItems, gifts) {
  const items = [];

  // Add regular cart items
  for (const it of quoteItems || []) {
    if (!it?.productId) continue;
    items.push({
      productId: String(it.productId),
      variantId: String(it.variantId || ""),
      qty: Math.max(1, Math.min(999, Number(it.qty || 1))),
    });
  }

  // Add gift items (use same reservation structure)
  for (const g of gifts || []) {
    if (!g?.productId) continue;
    items.push({
      productId: String(g.productId),
      variantId: String(g.variantId || ""),
      qty: Math.max(1, Math.min(50, Number(g.qty || 1))),
      isGift: true, // marker for debugging
    });
  }

  return items;
}

/**
 * Stripe service expects quote.items, quote.subtotal/shippingFee/total.
 * Keep it clean: pass quote as-is (single truth).
 */
function buildStripeQuote(quote) {
  return {
    subtotal: Number(quote.subtotal || 0),
    shippingFee: Number(quote.shippingFee || 0),
    discounts: quote.discounts || {
      coupon: { code: null, amount: 0 },
      campaign: { amount: 0 },
      offer: { amount: 0 },
    },
    total: Number(quote.total || 0),
    items: Array.isArray(quote.items) ? quote.items : [],
  };
}

/* ============================
   Idempotency helper
============================ */

async function findExistingCheckoutOrder({ userId, idemKey, paymentMethod }) {
  if (!idemKey || !userId) return null;

  const existing = await Order.findOne({
    userId,
    paymentMethod,
    "idempotency.checkoutKey": idemKey,
  }).sort({ createdAt: -1 });

  return existing || null;
}

/* ============================
   Routes
============================ */

/**
 * POST /api/checkout/quote
 * ✅ Single truth pricing for UI
 */
router.post(
  "/quote",
  optionalAuth(),
  validate(quoteSchema),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const authUserId = req.user?._id || null;
      const cartItems = authUserId
        ? await getCartItemsOrThrow(authUserId)
        : (await getGuestCartItemsOrThrow(req)).items;

      const quote = await quotePricing({
        cartItems,
        shipping: toShippingInput(b),
        couponCode: b.couponCode,
        userId: authUserId,
      });

      return res.json({ ok: true, data: quote });
    } catch (e) {
      return jsonErr(res, e);
    }
  },
);

/**
 * POST /api/checkout/cod
 * ✅ MUST reuse quotePricing
 * ✅ Atomic stock decrement for items + gifts
 * ✅ Coupon usedCount increment with atomic idempotent consumption
 * ✅ Clear cart NOW
 * ✅ Idempotency supported (returns existing order if retry)
 */
router.post("/cod", optionalAuth(), validate(quoteSchema), async (req, res) => {
  let reserved = false;
  let orderId = null;
  let orderCreated = false;
  let fallbackUsed = false;
  let guestCartId = "";

  try {
    const b = req.validated.body;
    const authUserId = req.user?._id || null;
    const checkoutUser = authUserId
      ? req.user
      : await getOrCreateCheckoutUserFromGuestContact(b.guestContact);
    const checkoutUserId = checkoutUser?._id;
    if (!checkoutUserId)
      throw makeErr(401, "UNAUTHORIZED", "Unable to identify checkout user");

    const idemKey = pickIdempotencyKey(req);

    // idempotency: if exists, return it
    const existing = await findExistingCheckoutOrder({
      userId: checkoutUserId,
      idemKey,
      paymentMethod: "cod",
    });
    if (existing) return res.status(200).json({ ok: true, data: existing });

    let cartItems = [];
    if (authUserId) {
      cartItems = await getCartItemsOrThrow(authUserId);
    } else {
      const guestCart = await getGuestCartItemsOrThrow(req);
      cartItems = guestCart.items;
      guestCartId = guestCart.guestCartId;
    }

    const shipping = await attachShippingSnapshots(toShippingInput(b));

    const quote = await quotePricing({
      cartItems,
      shipping,
      couponCode: b.couponCode,
      userId: checkoutUserId,
    });

    // ✅ Check for gift stock warnings - if any gifts are out of stock, reject early
    const criticalGiftWarnings = (quote.meta?.giftWarnings || []).filter(
      (w) => w.type === "GIFT_OUT_OF_STOCK",
    );
    if (criticalGiftWarnings.length > 0) {
      return res.status(400).json({
        ok: false,
        error: {
          code: "GIFT_OUT_OF_STOCK",
          message: "One or more gift items are out of stock",
          details: criticalGiftWarnings,
          requestId: getRequestId(req),
          path: req.originalUrl || req.url || "",
        },
      });
    }

    await releaseExpiredReservations().catch((e) => {
      req.log.warn(
        { err: String(e?.message || e) },
        "[best-effort] checkout release expired reservations failed",
      );
    });

    const discountTotal = calcDiscountTotal(quote);
    const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");

    const orderItems = mapOrderItemsFromQuote(quote);
    const giftItems = mapGiftItemsFromQuote(quote);

    // ✅ Build reservation items: cart items + gifts (unified stock reservation)
    const reservationItems = buildReservationItems(quote.items, quote.gifts);

    const order = await withMongoTransaction(async (session) => {
      reserved = false;
      orderCreated = false;
      orderId = null;
      fallbackUsed = session === null;

      orderId = new mongoose.Types.ObjectId();
      const orderNumber = await getNextOrderNumber(session);

      // ✅ Reserve stock for BOTH items and gifts
      await reserveStockForOrder({
        orderId,
        userId: checkoutUserId,
        items: reservationItems,
        ttlMinutes: 15,
        session,
      });
      reserved = true;

      const created = await Order.create(
        [
          {
            _id: orderId,
            userId: checkoutUserId,
            orderNumber,

            items: orderItems,
            gifts: giftItems,

            status: "pending_cod",
            paymentMethod: "cod",

            pricing: {
              subtotal: Number(quote.subtotal || 0),
              shippingFee: Number(quote.shippingFee || 0),
              discounts: quote.discounts || {
                coupon: { code: null, amount: 0 },
                campaign: { amount: 0 },
                offer: { amount: 0 },
              },
              total: Number(quote.total || 0),
              vatRate: Number(quote.vatRate || 0),
              vatIncludedInPrices: Boolean(quote.vatIncludedInPrices || false),
              vatAmount: Number(quote.vatAmount || 0),
              totalBeforeVat: Number(quote.totalBeforeVat || 0),
              totalAfterVat: Number(quote.totalAfterVat || 0),

              // additive legacy
              discountTotal: Number(discountTotal || 0),
              couponCode: couponAppliedCode,
              campaignId: quote?.meta?.campaignId || null,

              // minor mirrors
              subtotalMinor: Number(quote.subtotalMinor || 0),
              shippingFeeMinor: Number(quote.shippingFeeMinor || 0),
              discountTotalMinor: Number(toMinorUnits(discountTotal || 0)),
              totalMinor: Number(quote.totalMinor || 0),
              vatAmountMinor: Number(quote.vatAmountMinor || 0),
              totalBeforeVatMinor: Number(quote.totalBeforeVatMinor || 0),
              totalAfterVatMinor: Number(quote.totalAfterVatMinor || 0),
            },
            pricingMinor: {
              subtotal: toMinorUnits(quote.subtotal || 0),
              shippingFee: toMinorUnits(quote.shippingFee || 0),
              vatAmount: toMinorUnits(quote.vatAmount || 0),
              totalBeforeVat: toMinorUnits(quote.totalBeforeVat || 0),
              totalAfterVat: toMinorUnits(quote.totalAfterVat || 0),
              total: toMinorUnits(quote.total || 0),
            },

            shipping,

            stripe: { sessionId: "", paymentIntentId: "" },

            poNumber: b.poNumber || "",
            isB2B: Boolean(checkoutUser?.b2bApproved),

            idempotency: {
              checkoutKey: idemKey || "",
            },

            couponReservation: couponAppliedCode
              ? {
                  code: couponAppliedCode,
                  status: "consumed",
                  reservedAt: new Date(),
                  expiresAt: null,
                }
              : undefined,
          },
        ],
        session ? { session } : {},
      );
      orderCreated = true;

      const confirmed = await confirmStockReservation({ orderId, session });
      if (!confirmed) {
        throw makeErr(
          409,
          "RESERVATION_INVALID",
          "Stock reservation expired or invalid",
        );
      }

      // ✅ Atomic coupon consumption with idempotency (COD only)
      if (couponAppliedCode) {
        const couponResult = await consumeCouponAtomic({
          code: couponAppliedCode,
          orderId,
          userId: checkoutUserId,
          discountAmount: Number(quote?.discounts?.coupon?.amount || 0),
          session,
        });
        if (!couponResult.success && !couponResult.alreadyUsed) {
          throw makeErr(
            400,
            couponResult.error || "COUPON_CONSUMPTION_FAILED",
            "Coupon could not be applied",
          );
        }
      }

      // clear only purchased items from cart after COD order placement
      // (keeps items added after checkout started)
      if (authUserId) {
        await clearPurchasedItemsFromCart(authUserId, orderItems, session);
      } else {
        await clearPurchasedItemsFromGuestCart(
          guestCartId,
          orderItems,
          session,
        );
      }

      return created?.[0] || created;
    });

    // Best-effort confirmation email — fire-and-forget, does not block response
    sendOrderConfirmationSafe(order._id).catch((e) => {
      req.log.warn(
        { err: String(e?.message || e), orderId: order._id },
        "[checkout.cod] confirmation email best-effort failed",
      );
    });

    // B2B tier progression evaluation (best-effort)
    if (order.isB2B && authUserId) {
      evaluateTierProgression(authUserId, Number(order.pricing?.total || 0)).catch(() => {});
    }

    return res.status(201).json({ ok: true, data: order });
  } catch (e) {
    // Best-effort cleanup in fallback mode (no transaction)
    if (fallbackUsed && reserved && orderId) {
      await releaseStockReservation({ orderId }).catch((cleanupErr) => {
        req.log.warn(
          { err: String(cleanupErr?.message || cleanupErr) },
          "[best-effort] checkout release stock reservation failed",
        );
      });
    }
    if (fallbackUsed && orderCreated && orderId) {
      await Order.deleteOne({ _id: orderId }).catch((cleanupErr) => {
        req.log.warn(
          { err: String(cleanupErr?.message || cleanupErr) },
          "[best-effort] checkout cleanup delete order failed",
        );
      });
    }

    // Return the original structured error instead of masking with generic 500
    return jsonErr(res, e);
  }
});

/**
 * POST /api/checkout/bank-transfer
 * B2B only — creates order with pending_payment status, awaiting bank transfer confirmation.
 */
router.post("/bank-transfer", requireAuth(), validate(quoteSchema), async (req, res) => {
  try {
    const b = req.validated?.body ?? req.body;
    const userId = req.user._id;

    const user = await User.findById(userId).select("b2bApproved wholesaleTier taxId businessName").lean();
    if (!user?.b2bApproved) {
      return jsonErr(res, makeErr(403, "NOT_B2B", "Bank transfer is only available for B2B accounts"));
    }

    const cartItems = await getCartItemsOrThrow(userId);

    const shipping = await attachShippingSnapshots(toShippingInput(b));

    const quote = await quotePricing({
      cartItems,
      shipping,
      couponCode: b.couponCode || null,
      userId,
    });

    const orderItems = mapOrderItemsFromQuote(quote);
    const giftItems = mapGiftItemsFromQuote(quote);
    const discountTotal = calcDiscountTotal(quote);
    const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");

    const orderId = new mongoose.Types.ObjectId();
    const orderNumber = await getNextOrderNumber(null);

    const created = await Order.create([
      {
        _id: orderId,
        userId,
        orderNumber,
        items: orderItems,
        gifts: giftItems,
        status: "pending_payment",
        paymentMethod: "bank_transfer",
        poNumber: b.poNumber || "",
        isB2B: true,
        pricing: {
          subtotal: Number(quote.subtotal || 0),
          shippingFee: Number(quote.shippingFee || 0),
          discounts: quote.discounts || { coupon: { code: null, amount: 0 }, campaign: { amount: 0 }, offer: { amount: 0 } },
          total: Number(quote.total || 0),
          vatRate: Number(quote.vatRate || 0),
          vatIncludedInPrices: Boolean(quote.vatIncludedInPrices || false),
          vatAmount: Number(quote.vatAmount || 0),
          totalBeforeVat: Number(quote.totalBeforeVat || 0),
          totalAfterVat: Number(quote.totalAfterVat || 0),
          discountTotal: Number(discountTotal || 0),
          couponCode: couponAppliedCode,
          subtotalMinor: Number(quote.subtotalMinor || 0),
          shippingFeeMinor: Number(quote.shippingFeeMinor || 0),
          discountTotalMinor: Number(toMinorUnits(discountTotal || 0)),
          totalMinor: Number(quote.totalMinor || 0),
          vatAmountMinor: Number(quote.vatAmountMinor || 0),
          totalBeforeVatMinor: Number(quote.totalBeforeVatMinor || 0),
          totalAfterVatMinor: Number(quote.totalAfterVatMinor || 0),
        },
        pricingMinor: {
          subtotal: toMinorUnits(quote.subtotal || 0),
          shippingFee: toMinorUnits(quote.shippingFee || 0),
          vatAmount: toMinorUnits(quote.vatAmount || 0),
          totalBeforeVat: toMinorUnits(quote.totalBeforeVat || 0),
          totalAfterVat: toMinorUnits(quote.totalAfterVat || 0),
          total: toMinorUnits(quote.total || 0),
        },
        shipping,
        invoice: {
          customerVatId: String(user.taxId || ""),
          customerCompanyName: String(user.businessName || ""),
        },
      },
    ]);

    const order = created?.[0] || created;

    await clearPurchasedItemsFromCart(userId, orderItems, null);
    sendOrderConfirmationSafe(order._id).catch(() => {});

    // B2B tier progression evaluation (best-effort)
    evaluateTierProgression(userId, Number(quote.total || 0)).catch(() => {});

    return res.status(201).json({ ok: true, data: order });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/checkout/net-terms
 * B2B only — creates order on credit (Net 30/60/etc). Requires credit limit.
 */
router.post("/net-terms", requireAuth(), validate(quoteSchema), async (req, res) => {
  try {
    const b = req.validated?.body ?? req.body;
    const userId = req.user._id;

    const user = await User.findById(userId).select("b2bApproved wholesaleTier taxId businessName creditLimit creditTermDays creditBalance").lean();
    if (!user?.b2bApproved) {
      return jsonErr(res, makeErr(403, "NOT_B2B", "B2B account required for net terms"));
    }
    if (!user.creditLimit || user.creditLimit <= 0) {
      return jsonErr(res, makeErr(400, "NO_CREDIT", "No credit limit configured. Contact admin."));
    }

    const cartItems = await getCartItemsOrThrow(userId);
    const shipping = await attachShippingSnapshots(toShippingInput(b));

    const quote = await quotePricing({
      cartItems,
      shipping,
      couponCode: b.couponCode || null,
      userId,
    });

    const orderTotal = Number(quote.total || 0);
    const newBalance = (user.creditBalance || 0) + orderTotal;
    if (newBalance > user.creditLimit) {
      return jsonErr(res, makeErr(400, "CREDIT_EXCEEDED", `Order exceeds credit limit. Available: ₪${(user.creditLimit - (user.creditBalance || 0)).toFixed(2)}`));
    }

    const orderItems = mapOrderItemsFromQuote(quote);
    const giftItems = mapGiftItemsFromQuote(quote);
    const discountTotal = calcDiscountTotal(quote);
    const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");
    const termDays = user.creditTermDays || 30;

    const orderId = new mongoose.Types.ObjectId();
    const orderNumber = await getNextOrderNumber(null);

    const created = await Order.create([
      {
        _id: orderId,
        userId,
        orderNumber,
        items: orderItems,
        gifts: giftItems,
        status: "confirmed",
        paymentMethod: "net_terms",
        paymentDueAt: new Date(Date.now() + termDays * 24 * 60 * 60 * 1000),
        poNumber: b.poNumber || "",
        isB2B: true,
        pricing: {
          subtotal: Number(quote.subtotal || 0),
          shippingFee: Number(quote.shippingFee || 0),
          discounts: quote.discounts || { coupon: { code: null, amount: 0 }, campaign: { amount: 0 }, offer: { amount: 0 } },
          total: orderTotal,
          vatRate: Number(quote.vatRate || 0),
          vatIncludedInPrices: Boolean(quote.vatIncludedInPrices || false),
          vatAmount: Number(quote.vatAmount || 0),
          totalBeforeVat: Number(quote.totalBeforeVat || 0),
          totalAfterVat: Number(quote.totalAfterVat || 0),
          discountTotal: Number(discountTotal || 0),
          couponCode: couponAppliedCode,
          subtotalMinor: Number(quote.subtotalMinor || 0),
          shippingFeeMinor: Number(quote.shippingFeeMinor || 0),
          discountTotalMinor: Number(toMinorUnits(discountTotal || 0)),
          totalMinor: Number(quote.totalMinor || 0),
          vatAmountMinor: Number(quote.vatAmountMinor || 0),
          totalBeforeVatMinor: Number(quote.totalBeforeVatMinor || 0),
          totalAfterVatMinor: Number(quote.totalAfterVatMinor || 0),
        },
        pricingMinor: {
          subtotal: toMinorUnits(quote.subtotal || 0),
          shippingFee: toMinorUnits(quote.shippingFee || 0),
          vatAmount: toMinorUnits(quote.vatAmount || 0),
          totalBeforeVat: toMinorUnits(quote.totalBeforeVat || 0),
          totalAfterVat: toMinorUnits(quote.totalAfterVat || 0),
          total: toMinorUnits(quote.total || 0),
        },
        shipping,
        invoice: {
          customerVatId: String(user.taxId || ""),
          customerCompanyName: String(user.businessName || ""),
        },
      },
    ]);

    // Update credit balance
    await User.updateOne({ _id: userId }, { $inc: { creditBalance: orderTotal } });

    const order = created?.[0] || created;
    await clearPurchasedItemsFromCart(userId, orderItems, null);
    sendOrderConfirmationSafe(order._id).catch(() => {});

    // B2B tier progression evaluation (best-effort)
    evaluateTierProgression(userId, orderTotal).catch(() => {});

    return res.status(201).json({ ok: true, data: order });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/checkout/stripe
 * ✅ MUST reuse quotePricing
 * ✅ Create pending_payment order
 * ✅ DO NOT increment coupon usedCount here (done by webhook after success)
 * ✅ DO NOT clear cart here (safer UX)
 * ✅ Idempotency supported (returns existing order + existing session.url if possible)
 */
router.post(
  "/stripe",
  optionalAuth(),
  validate(quoteSchema),
  async (req, res) => {
    let reserved = false;
    let orderId = null;
    let lastSessionUsed = false;
    let couponReserved = false;
    let couponCodeForReservation = "";
    let couponReservationExpiresAt = null;
    let orderCreated = false;
    let fallbackUsed = false;
    let cleanupPerformed = false;
    try {
      const b = req.validated.body;
      const authUserId = req.user?._id || null;
      const checkoutUser = authUserId
        ? req.user
        : await getOrCreateCheckoutUserFromGuestContact(b.guestContact);
      const checkoutUserId = checkoutUser?._id;
      if (!checkoutUserId)
        throw makeErr(401, "UNAUTHORIZED", "Unable to identify checkout user");

      const cartItems = authUserId
        ? await getCartItemsOrThrow(authUserId)
        : (await getGuestCartItemsOrThrow(req)).items;

      const idemKey = pickIdempotencyKey(req);

      // idempotency: if exists, return existing session if possible
      const existing = await findExistingCheckoutOrder({
        userId: checkoutUserId,
        idemKey,
        paymentMethod: "stripe",
      });

      if (existing) {
        const baseData = {
          orderId: existing._id,
          orderNumber: existing.orderNumber || "",
          checkoutUrl: null,
        };

        const sessionId = String(existing?.stripe?.sessionId || "");
        if (sessionId) {
          try {
            const sess = await retrieveCheckoutSession(sessionId, {
              expandPaymentIntent: false,
            });
            return res.json({
              ok: true,
              data: {
                ...baseData,
                checkoutUrl: sess?.url || null,
              },
            });
          } catch (e) {
            req.log.warn(
              { err: String(e?.message || e) },
              "[best-effort] checkout stripe retrieve session failed",
            );
            // retrieve failed - fall through to return baseData (frontend can retry with new key)
            return res.json({ ok: true, data: baseData });
          }
        }

        return res.json({ ok: true, data: baseData });
      }

      const shipping = toShippingInput(b);
      const shippingWithSnapshots = await attachShippingSnapshots(shipping);

      const quote = await quotePricing({
        cartItems,
        shipping: shippingWithSnapshots,
        couponCode: b.couponCode,
        userId: checkoutUserId,
      });

      // ✅ Check for gift stock warnings - if any gifts are out of stock, reject early
      const criticalGiftWarnings = (quote.meta?.giftWarnings || []).filter(
        (w) => w.type === "GIFT_OUT_OF_STOCK",
      );
      if (criticalGiftWarnings.length > 0) {
        return res.status(400).json({
          ok: false,
          error: {
            code: "GIFT_OUT_OF_STOCK",
            message: "One or more gift items are out of stock",
            details: criticalGiftWarnings,
            requestId: getRequestId(req),
            path: req.originalUrl || req.url || "",
          },
        });
      }

      await releaseExpiredReservations().catch((e) => {
        req.log.warn(
          { err: String(e?.message || e) },
          "[best-effort] checkout release expired reservations failed",
        );
      });

      const discountTotal = calcDiscountTotal(quote);
      const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");
      couponCodeForReservation = couponAppliedCode;

      const orderItems = mapOrderItemsFromQuote(quote);
      const giftItems = mapGiftItemsFromQuote(quote);

      // ✅ Build reservation items: cart items + gifts (unified stock reservation)
      const reservationItems = buildReservationItems(quote.items, quote.gifts);

      const order = await withMongoTransaction(async (session) => {
        fallbackUsed = session === null;
        reserved = false;
        orderCreated = false;
        orderId = new mongoose.Types.ObjectId();
        const orderNumber = await getNextOrderNumber(session);

        if (couponAppliedCode) {
          const resv = await reserveCouponAtomic({
            code: couponAppliedCode,
            orderId,
            userId: checkoutUserId,
            ttlMinutes: Number(
              process.env.COUPON_RESERVATION_TTL_MINUTES || 15,
            ),
            session,
          });
          if (!resv.success) {
            throw makeErr(
              400,
              resv.error || "COUPON_RESERVATION_FAILED",
              "Coupon could not be reserved",
            );
          }
          couponReserved = true;
          couponReservationExpiresAt =
            resv.expiresAt || getCouponReservationExpiry();
        }

        // ✅ Reserve stock for BOTH items and gifts
        await reserveStockForOrder({
          orderId,
          userId: checkoutUserId,
          items: reservationItems,
          ttlMinutes: 15,
          session,
        });
        reserved = true;

        const created = await Order.create(
          [
            {
              _id: orderId,
              userId: checkoutUserId,
              orderNumber,

              items: orderItems,
              gifts: giftItems,

              status: "pending_payment",
              paymentMethod: "stripe",

              pricing: {
                subtotal: Number(quote.subtotal || 0),
                shippingFee: Number(quote.shippingFee || 0),
                discounts: quote.discounts || {
                  coupon: { code: null, amount: 0 },
                  campaign: { amount: 0 },
                  offer: { amount: 0 },
                },
                total: Number(quote.total || 0),
                vatRate: Number(quote.vatRate || 0),
                vatIncludedInPrices: Boolean(
                  quote.vatIncludedInPrices || false,
                ),
                vatAmount: Number(quote.vatAmount || 0),
                totalBeforeVat: Number(quote.totalBeforeVat || 0),
                totalAfterVat: Number(quote.totalAfterVat || 0),

                // additive legacy
                discountTotal: Number(discountTotal || 0),
                couponCode: couponAppliedCode,
                campaignId: quote?.meta?.campaignId || null,

                // minor mirrors
                subtotalMinor: Number(quote.subtotalMinor || 0),
                shippingFeeMinor: Number(quote.shippingFeeMinor || 0),
                discountTotalMinor: Number(toMinorUnits(discountTotal || 0)),
                totalMinor: Number(quote.totalMinor || 0),
                vatAmountMinor: Number(quote.vatAmountMinor || 0),
                totalBeforeVatMinor: Number(quote.totalBeforeVatMinor || 0),
                totalAfterVatMinor: Number(quote.totalAfterVatMinor || 0),
              },
              pricingMinor: {
                subtotal: toMinorUnits(quote.subtotal || 0),
                shippingFee: toMinorUnits(quote.shippingFee || 0),
                vatAmount: toMinorUnits(quote.vatAmount || 0),
                totalBeforeVat: toMinorUnits(quote.totalBeforeVat || 0),
                totalAfterVat: toMinorUnits(quote.totalAfterVat || 0),
                total: toMinorUnits(quote.total || 0),
              },

              shipping: shippingWithSnapshots,

              stripe: { sessionId: "", paymentIntentId: "" },

              poNumber: b.poNumber || "",
              isB2B: Boolean(checkoutUser?.b2bApproved),

              idempotency: {
                checkoutKey: idemKey || "",
              },

              couponReservation: couponAppliedCode
                ? {
                    code: couponAppliedCode,
                    status: "reserved",
                    reservedAt: new Date(),
                    expiresAt:
                      couponReservationExpiresAt ||
                      getCouponReservationExpiry(),
                  }
                : undefined,
            },
          ],
          session ? { session } : {},
        );

        orderCreated = true;
        return created?.[0] || created;
      });

      const stripeQuote = buildStripeQuote(quote);

      let session;
      try {
        session = await createCheckoutSession({
          orderId: order._id.toString(),
          quote: stripeQuote,
          lang: req.lang,
          idempotencyKey: idemKey || undefined,
          customerEmail: checkoutUser.email || undefined,
        });
      } catch (err) {
        await releaseStockReservation({ orderId: order._id }).catch((e) => {
          req.log.warn(
            { err: String(e?.message || e) },
            "[best-effort] checkout release stock reservation failed",
          );
        });
        if (couponAppliedCode) {
          await releaseCouponReservation({
            code: couponAppliedCode,
            orderId: order._id,
          }).catch((e) => {
            req.log.warn(
              { err: String(e?.message || e) },
              "[best-effort] checkout release coupon reservation failed",
            );
          });
        }
        await Order.updateOne(
          { _id: order._id, status: "pending_payment" },
          {
            $set: {
              status: "cancelled",
              internalNote: "Checkout session creation failed (auto-cancelled)",
              ...(couponAppliedCode
                ? { "couponReservation.status": "released" }
                : {}),
            },
          },
        ).catch((e) => {
          req.log.warn(
            { err: String(e?.message || e) },
            "[best-effort] checkout cleanup order cancel failed",
          );
        });
        cleanupPerformed = true;
        throw err;
      }

      order.stripe = order.stripe || {};
      order.stripe.sessionId = String(session?.id || "");
      await order.save();

      return res.json({
        ok: true,
        data: {
          orderId: order._id,
          orderNumber: order.orderNumber || "",
          checkoutUrl: session?.url || null,
        },
      });
    } catch (e) {
      if (!cleanupPerformed && fallbackUsed && reserved && orderId) {
        await releaseStockReservation({ orderId }).catch((err) => {
          req.log.warn(
            { err: String(err?.message || err) },
            "[best-effort] checkout release stock reservation failed",
          );
        });
      }
      if (!cleanupPerformed && fallbackUsed && orderCreated && orderId) {
        await Order.deleteOne({
          _id: orderId,
          status: "pending_payment",
          "stripe.sessionId": "",
        }).catch((err) => {
          req.log.warn(
            { err: String(err?.message || err) },
            "[best-effort] checkout cleanup delete order failed",
          );
        });
      }
      if (
        !cleanupPerformed &&
        fallbackUsed &&
        couponReserved &&
        couponCodeForReservation &&
        orderId
      ) {
        await releaseCouponReservation({
          code: couponCodeForReservation,
          orderId,
        }).catch((cleanupErr) => {
          req.log.warn(
            { err: String(cleanupErr?.message || cleanupErr) },
            "[best-effort] checkout release coupon reservation failed",
          );
        });
      }
      return jsonErr(res, e);
    }
  },
);

export default router;
