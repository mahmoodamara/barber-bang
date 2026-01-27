// src/routes/checkout.routes.js

import express from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { Coupon } from "../models/Coupon.js";
import { Counter } from "../models/Counter.js";

import { quotePricing } from "../services/pricing.service.js";
import { createCheckoutSession, retrieveCheckoutSession } from "../services/stripe.service.js";
import {
  reserveStockForOrder,
  confirmStockReservation,
  releaseStockReservation,
  releaseExpiredReservations,
} from "../services/products.service.js";

const router = express.Router();

/* ============================
   Zod Schemas
============================ */

const addressSchema = z.object({
  fullName: z.string().min(2).max(80),
  phone: z.string().min(7).max(30),
  city: z.string().min(2).max(60),
  street: z.string().min(2).max(120),
  notes: z.string().max(300).optional(),
});

const baseCheckoutBodySchema = z
  .object({
    shippingMode: z.enum(["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"]),
    deliveryAreaId: z.string().min(1).optional(),
    pickupPointId: z.string().min(1).optional(),
    address: addressSchema.optional(),
    couponCode: z.string().max(40).optional(),
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

function jsonErr(res, e) {
  return res.status(e?.statusCode || 500).json({
    ok: false,
    error: {
      code: e?.code || "INTERNAL_ERROR",
      message: e?.message || "Unexpected error",
    },
  });
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
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
    }
  );

  const seq = Number(counter?.seq || 0);
  const padded = String(Math.max(0, seq)).padStart(6, "0");
  return `BB-${year}-${padded}`;
}

/* ============================
   Cart / Shipping helpers
============================ */

async function getCartItemsOrThrow(userId) {
  const user = await User.findById(userId).select("cart").lean();
  if (!user) throw makeErr(401, "UNAUTHORIZED", "User not found");

  const cart = user?.cart || [];
  const items = cart
    .map((x) => ({
      productId: x.productId?.toString?.() || String(x.productId || ""),
      qty: Math.max(1, Math.min(999, Number(x.qty || 1))),
    }))
    .filter((x) => x.productId);

  if (!items.length) throw makeErr(400, "CART_EMPTY", "Cart is empty");
  return items;
}

/**
 * IMPORTANT:
 * Order model shipping.address is an object, NOT nullable.
 * So we always send an address object with safe defaults,
 * even for pickup/store pickup.
 */
function toShippingInput(body) {
  const a = body.address || null;

  const safeAddress = {
    fullName: String(a?.fullName || ""),
    phone: String(a?.phone || ""),
    city: String(a?.city || ""),
    street: String(a?.street || ""),
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
    }));
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
  if (!idemKey) return null;

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
router.post("/quote", requireAuth(), validate(quoteSchema), async (req, res) => {
  try {
    const cartItems = await getCartItemsOrThrow(req.user._id);
    const b = req.validated.body;

    const quote = await quotePricing({
      cartItems,
      shipping: toShippingInput(b),
      couponCode: b.couponCode,
    });

    return res.json({ ok: true, data: quote });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/checkout/cod
 * ✅ MUST reuse quotePricing
 * ✅ Atomic stock decrement
 * ✅ Coupon usedCount increment NOW
 * ✅ Clear cart NOW
 * ✅ Idempotency supported (returns existing order if retry)
 */
router.post("/cod", requireAuth(), validate(quoteSchema), async (req, res) => {
  const session = await mongoose.startSession().catch(() => null);
  let reserved = false;
  let orderId = null;

  try {
    const cartItems = await getCartItemsOrThrow(req.user._id);
    const b = req.validated.body;

    const idemKey = pickIdempotencyKey(req);

    // idempotency: if exists, return it
    const existing = await findExistingCheckoutOrder({
      userId: req.user._id,
      idemKey,
      paymentMethod: "cod",
    });
    if (existing) return res.status(200).json({ ok: true, data: existing });

    const shipping = toShippingInput(b);

    const quote = await quotePricing({
      cartItems,
      shipping,
      couponCode: b.couponCode,
    });

    await releaseExpiredReservations().catch(() => {});

    const discountTotal = calcDiscountTotal(quote);
    const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");

    const orderItems = mapOrderItemsFromQuote(quote);
    const giftItems = mapGiftItemsFromQuote(quote);

    // Transaction if supported (replica set). Otherwise fallback.
    if (session) session.startTransaction();

    orderId = new mongoose.Types.ObjectId();
    const orderNumber = await getNextOrderNumber(session);

    await reserveStockForOrder({
      orderId,
      userId: req.user._id,
      items: quote.items,
      ttlMinutes: 15,
      session,
    });
    reserved = true;

    const order = await Order.create(
      [
        {
          _id: orderId,
          userId: req.user._id,
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
            vatAmount: Number(quote.vatAmount || 0),
            totalBeforeVat: Number(quote.totalBeforeVat || 0),
            totalAfterVat: Number(quote.totalAfterVat || 0),

            // additive legacy
            discountTotal: Number(discountTotal || 0),
            couponCode: couponAppliedCode,
            campaignId: quote?.meta?.campaignId || null,
          },

          shipping,

          stripe: { sessionId: "", paymentIntentId: "" },

          idempotency: {
            checkoutKey: idemKey || "",
          },
        },
      ],
      session ? { session } : {}
    );

    await confirmStockReservation({ orderId, session });

    // coupon usage for COD only
    if (couponAppliedCode) {
      await Coupon.updateOne(
        { code: couponAppliedCode },
        { $inc: { usedCount: 1 } },
        session ? { session } : {}
      );
    }

    // clear cart after COD order placement
    await User.updateOne(
      { _id: req.user._id },
      { $set: { cart: [] } },
      session ? { session } : {}
    );

    if (session) await session.commitTransaction();

    return res.status(201).json({ ok: true, data: order?.[0] || order });
  } catch (e) {
    if (session) {
      try {
        await session.abortTransaction();
      } catch {}
    }
    if (!session && reserved && orderId) {
      await releaseStockReservation({ orderId }).catch(() => {});
    }
    return jsonErr(res, e);
  } finally {
    if (session) session.endSession();
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
router.post("/stripe", requireAuth(), validate(quoteSchema), async (req, res) => {
  let reserved = false;
  let orderId = null;
  try {
    const cartItems = await getCartItemsOrThrow(req.user._id);
    const b = req.validated.body;

    const idemKey = pickIdempotencyKey(req);

    // idempotency: if exists, return existing session if possible
    const existing = await findExistingCheckoutOrder({
      userId: req.user._id,
      idemKey,
      paymentMethod: "stripe",
    });

    if (existing) {
      const sessionId = String(existing?.stripe?.sessionId || "");
      if (sessionId) {
        try {
          const sess = await retrieveCheckoutSession(sessionId, { expandPaymentIntent: false });
          return res.json({
            ok: true,
            data: {
              orderId: existing._id,
              orderNumber: existing.orderNumber || "",
              checkoutUrl: sess?.url || null,
            },
          });
        } catch {
          // if retrieve fails, still return orderId (frontend can retry creating again with a new key)
          return res.json({
            ok: true,
            data: {
              orderId: existing._id,
              orderNumber: existing.orderNumber || "",
              checkoutUrl: null,
            },
          });
        }
      }

      return res.json({
        ok: true,
        data: {
          orderId: existing._id,
          orderNumber: existing.orderNumber || "",
          checkoutUrl: null,
        },
      });
    }

    const shipping = toShippingInput(b);

    const quote = await quotePricing({
      cartItems,
      shipping,
      couponCode: b.couponCode,
    });

    await releaseExpiredReservations().catch(() => {});

    const discountTotal = calcDiscountTotal(quote);
    const couponAppliedCode = String(quote?.discounts?.coupon?.code || "");

    const orderItems = mapOrderItemsFromQuote(quote);
    const giftItems = mapGiftItemsFromQuote(quote);

    orderId = new mongoose.Types.ObjectId();
    const orderNumber = await getNextOrderNumber();

    await reserveStockForOrder({
      orderId,
      userId: req.user._id,
      items: quote.items,
      ttlMinutes: 15,
    });
    reserved = true;

    const order = await Order.create({
      _id: orderId,
      userId: req.user._id,
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
        vatAmount: Number(quote.vatAmount || 0),
        totalBeforeVat: Number(quote.totalBeforeVat || 0),
        totalAfterVat: Number(quote.totalAfterVat || 0),

        // additive legacy
        discountTotal: Number(discountTotal || 0),
        couponCode: couponAppliedCode,
        campaignId: quote?.meta?.campaignId || null,
      },

      shipping,

      stripe: { sessionId: "", paymentIntentId: "" },

      idempotency: {
        checkoutKey: idemKey || "",
      },
    });

    const stripeQuote = buildStripeQuote(quote);

    let session;
    try {
      session = await createCheckoutSession({
        orderId: order._id.toString(),
        quote: stripeQuote,
        lang: req.lang,
        idempotencyKey: idemKey || undefined,
      });
    } catch (err) {
      await Order.deleteOne({ _id: order._id }).catch(() => {});
      await releaseStockReservation({ orderId: order._id }).catch(() => {});
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
    if (reserved && orderId) {
      await releaseStockReservation({ orderId }).catch(() => {});
      await Order.deleteOne({ _id: orderId, status: "pending_payment", "stripe.sessionId": "" }).catch(
        () => {}
      );
    }
    return jsonErr(res, e);
  }
});

export default router;
