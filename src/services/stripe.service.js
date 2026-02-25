// src/services/stripe.service.js
import Stripe from "stripe";

let stripeClient = null;

/* ============================
   Errors
============================ */

function makeErr(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function safeLower(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s ? s.toLowerCase() : fallback;
}

/* ============================
   Stripe client
============================ */

function getStripe() {
  if (stripeClient) return stripeClient;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key)
    throw makeErr(
      500,
      "STRIPE_NOT_CONFIGURED",
      "STRIPE_SECRET_KEY is required",
    );

  /**
   * apiVersion: keep stable. If you change, adjust fields accordingly.
   */
  stripeClient = new Stripe(key, { apiVersion: "2024-06-20" });

  return stripeClient;
}

/* ============================
   Money helpers (ILS major <-> minor)
============================ */

export function toMinorUnits(major) {
  const n = Number(major || 0);
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

export function fromMinorUnits(minor) {
  const n = Number(minor || 0);
  return Math.round(n + Number.EPSILON) / 100;
}

/* ============================
   Language helpers
============================ */

function safeLang(lang) {
  const v = String(lang || "he").toLowerCase();
  return v === "ar" ? "ar" : "he";
}

function pickTitle(it, lang) {
  const l = safeLang(lang);
  if (l === "ar") return it?.titleAr || it?.titleHe || it?.title || "Item";
  return it?.titleHe || it?.titleAr || it?.title || "Item";
}

/* ============================
   Discount allocation helper
============================ */

/**
 * Allocate order-level discount across items proportionally
 * in minor units to avoid floating drift.
 */
function allocateDiscountAcrossItems({ linesMinor, totalDiscountMinor }) {
  if (totalDiscountMinor <= 0) {
    return { perLineDiscountMinor: linesMinor.map(() => 0), remainderMinor: 0 };
  }

  const subtotalMinor = linesMinor.reduce((a, b) => a + b, 0);
  if (subtotalMinor <= 0) {
    return {
      perLineDiscountMinor: linesMinor.map(() => 0),
      remainderMinor: totalDiscountMinor,
    };
  }

  const raw = linesMinor.map(
    (line) => (totalDiscountMinor * line) / subtotalMinor,
  );
  const floors = raw.map((x) => Math.floor(x));
  let used = floors.reduce((a, b) => a + b, 0);
  let remainder = totalDiscountMinor - used;

  const fractional = raw.map((x, idx) => ({ idx, frac: x - Math.floor(x) }));
  fractional.sort((a, b) => b.frac - a.frac);

  const perLineDiscountMinor = [...floors];

  for (let i = 0; i < fractional.length && remainder > 0; i++) {
    perLineDiscountMinor[fractional[i].idx] += 1;
    remainder -= 1;
  }

  return { perLineDiscountMinor, remainderMinor: remainder };
}

/* ============================
   Safety helpers
============================ */

function sumLineItemsMinor(line_items) {
  return (line_items || []).reduce((acc, li) => {
    const unit = Number(li?.price_data?.unit_amount || 0);
    const qty = Number(li?.quantity || 1);
    return acc + unit * qty;
  }, 0);
}

/**
 * Ensures Stripe sum(line_items) equals quote.total exactly in minor units.
 */
function verifyStripeTotal({ quoteTotalMinor, line_items }) {
  const sumMinor = sumLineItemsMinor(line_items);
  const diff = quoteTotalMinor - sumMinor;

  return { sumMinor, diff };
}

/**
 * Hard sanitize path joins for URL building
 * Ensures URL has a valid scheme (https:// or http://)
 */
function normalizeUrlBase(raw) {
  let base = String(raw || "").trim();
  if (!base) return "";

  // Remove trailing slashes
  base = base.replace(/\/+$/, "");

  // Ensure URL has a scheme
  if (base && !base.startsWith("http://") && !base.startsWith("https://")) {
    // Default to https for production URLs
    base = `https://${base}`;
  }

  return base;
}

/* ============================
   Stripe Checkout Session
============================ */

/**
 * ✅ Creates Stripe Checkout session from quote truth ONLY
 *
 * Expected quote shape:
 * {
 *   subtotal,
 *   shippingFee,
 *   discounts: { coupon:{code,amount}, campaign:{amount}, offer:{amount} },
 *   total,
 *   items:[{ productId, qty, unitPrice, titleHe, titleAr, title }]
 * }
 */
export async function createCheckoutSession({
  orderId,
  quote,
  lang,
  idempotencyKey,
  customerEmail,
}) {
  const stripe = getStripe();

  if (!orderId) throw makeErr(400, "MISSING_ORDER_ID", "orderId is required");
  if (!quote || !Array.isArray(quote.items) || quote.items.length === 0) {
    throw makeErr(400, "INVALID_QUOTE", "quote.items is required");
  }

  const currency = safeLower(process.env.STRIPE_CURRENCY, "ils");
  const L = safeLang(lang);

  const subtotalMinor = toMinorUnits(quote.subtotal);
  const shippingMinor = toMinorUnits(quote.shippingFee);
  const totalMinor = toMinorUnits(quote.total);

  if (totalMinor <= 0) {
    throw makeErr(400, "INVALID_TOTAL", "quote.total must be > 0");
  }

  // Quote truth: total = subtotal - discounts + shipping
  const totalBeforeShippingMinor = Math.max(0, totalMinor - shippingMinor);
  const totalDiscountMinor = Math.max(
    0,
    subtotalMinor - totalBeforeShippingMinor,
  );

  // Base line totals in minor
  const linesMinor = quote.items.map((it) => {
    const qty = Math.max(1, Math.min(999, Number(it.qty || 1)));
    const unitMinor = toMinorUnits(it.unitPrice);
    return unitMinor * qty;
  });

  // Allocate discounts
  const { perLineDiscountMinor } = allocateDiscountAcrossItems({
    linesMinor,
    totalDiscountMinor,
  });

  const line_items = [];

  // Add items as line_items (after discount allocation)
  for (let i = 0; i < quote.items.length; i++) {
    const it = quote.items[i];
    const qty = Math.max(1, Math.min(999, Number(it.qty || 1)));

    const originalLineMinor = linesMinor[i];
    const discountMinor = Math.min(
      perLineDiscountMinor[i] || 0,
      originalLineMinor,
    );
    const adjustedLineMinor = Math.max(0, originalLineMinor - discountMinor);

    // distribute adjusted line per unit, handle remainder
    const unitMinor = Math.floor(adjustedLineMinor / qty);
    const remainder = adjustedLineMinor - unitMinor * qty;

    const name = pickTitle(it, L);

    // unitMinor can be zero if fully discounted — skip that line
    if (unitMinor > 0) {
      line_items.push({
        price_data: {
          currency,
          product_data: { name },
          unit_amount: unitMinor,
        },
        quantity: qty,
      });
    }

    // remainder adds a single extra line item
    if (remainder > 0) {
      line_items.push({
        price_data: {
          currency,
          product_data: { name: `${name} (adj)` },
          unit_amount: remainder,
        },
        quantity: 1,
      });
    }
  }

  // Add shipping as separate line item
  if (shippingMinor > 0) {
    const shippingLabel = L === "ar" ? "الشحن" : "משלוח";
    line_items.push({
      price_data: {
        currency,
        product_data: { name: shippingLabel },
        unit_amount: shippingMinor,
      },
      quantity: 1,
    });
  }

  // If everything got discounted to zero and shipping is zero => Stripe rejects empty line_items
  if (line_items.length === 0) {
    const label = L === "ar" ? "إجمالي الطلب" : "סך ההזמנה";
    line_items.push({
      price_data: {
        currency,
        product_data: { name: label },
        unit_amount: totalMinor,
      },
      quantity: 1,
    });
  }

  // Ensure sum(line_items) === totalMinor
  const { diff } = verifyStripeTotal({
    quoteTotalMinor: totalMinor,
    line_items,
  });

  if (diff !== 0) {
    // if negative diff => line_items exceed total => fatal bug
    if (diff < 0) {
      throw makeErr(
        500,
        "STRIPE_TOTAL_MISMATCH",
        `Stripe line items exceed quote.total (diff=${fromMinorUnits(diff)})`,
        { diffMinor: diff },
      );
    }

    // add adjustment line item (positive)
    const adjLabel = L === "ar" ? "تسوية" : "התאמה";
    line_items.push({
      price_data: {
        currency,
        product_data: { name: adjLabel },
        unit_amount: diff,
      },
      quantity: 1,
    });
  }

  // Build URLs
  // Production fallback: use Netlify frontend if no env var is set
  const envBase = process.env.CLIENT_URL || process.env.FRONTEND_URL;
  const productionFallback = "https://barber-bang.netlify.app";
  const devFallback = "http://localhost:5173";
  const isProd = process.env.NODE_ENV === "production";

  const base =
    normalizeUrlBase(envBase) || (isProd ? productionFallback : devFallback);

  const successPath = String(
    process.env.STRIPE_SUCCESS_PATH || "/checkout/success",
  );
  const cancelPath = String(
    process.env.STRIPE_CANCEL_PATH || "/checkout/cancel",
  );

  const successUrl = `${base}${successPath}?orderId=${encodeURIComponent(String(orderId))}`;
  const cancelUrl = `${base}${cancelPath}?orderId=${encodeURIComponent(String(orderId))}`;

  const metadata = {
    orderId: String(orderId),
    lang: L,
    total: String(quote.total),
    couponCode: String(quote?.discounts?.coupon?.code || ""),
  };

  const createParams = {
    mode: "payment",
    line_items,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    billing_address_collection: "auto",
    phone_number_collection: { enabled: true },
  };

  const createOpts = idempotencyKey
    ? { idempotencyKey: String(idempotencyKey) }
    : undefined;

  try {
    const session = await stripe.checkout.sessions.create(
      createParams,
      createOpts,
    );
    return session;
  } catch (e) {
    const msg = e?.message || "Stripe checkout session create failed";
    const code = e?.code || "STRIPE_CHECKOUT_CREATE_FAILED";
    throw makeErr(502, code, msg);
  }
}

/* ============================
   Webhook constructor (RAW BODY REQUIRED)
============================ */

export function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw makeErr(
      500,
      "STRIPE_WEBHOOK_NOT_CONFIGURED",
      "STRIPE_WEBHOOK_SECRET is required",
    );
  }

  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    const msg = e?.message || "Invalid webhook signature";
    throw makeErr(400, "STRIPE_WEBHOOK_SIGNATURE_INVALID", msg);
  }
}

/* ============================
   Refunds + Receipt helpers
============================ */

/**
 * Map internal reason -> Stripe supported reason (optional)
 * Stripe supports: requested_by_customer, duplicate, fraudulent
 */
function mapRefundReasonToStripe(reason) {
  const r = String(reason || "").toLowerCase();
  if (r === "customer_cancel" || r === "return") return "requested_by_customer";
  if (r === "duplicate") return "duplicate";
  if (r === "fraud") return "fraudulent";
  return null;
}

/**
 * Retrieve Checkout Session by ID (expand payment_intent optionally)
 */
export async function retrieveCheckoutSession(
  sessionId,
  { expandPaymentIntent = true } = {},
) {
  const stripe = getStripe();
  if (!sessionId)
    throw makeErr(400, "MISSING_SESSION_ID", "sessionId is required");

  const expand = [];
  if (expandPaymentIntent) expand.push("payment_intent");

  try {
    const session = await stripe.checkout.sessions.retrieve(
      String(sessionId),
      expand.length ? { expand } : undefined,
    );
    return session;
  } catch (e) {
    const msg = e?.message || "Stripe session retrieve failed";
    const code = e?.code || "STRIPE_SESSION_RETRIEVE_FAILED";
    throw makeErr(502, code, msg);
  }
}

/**
 * Retrieve PaymentIntent (expand latest_charge)
 */
export async function retrievePaymentIntent(paymentIntentId) {
  const stripe = getStripe();
  if (!paymentIntentId)
    throw makeErr(400, "MISSING_PAYMENT_INTENT", "paymentIntentId is required");

  try {
    const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId), {
      expand: ["latest_charge"],
    });
    return pi;
  } catch (e) {
    const msg = e?.message || "Stripe paymentIntent retrieve failed";
    const code = e?.code || "STRIPE_PI_RETRIEVE_FAILED";
    throw makeErr(502, code, msg);
  }
}

/**
 * Extract chargeId + receiptUrl from expanded PaymentIntent
 */
export function extractChargeAndReceiptFromPI(paymentIntent) {
  const latestCharge = paymentIntent?.latest_charge || null;

  if (!latestCharge) return { chargeId: "", receiptUrl: "" };

  if (typeof latestCharge === "string") {
    return { chargeId: latestCharge, receiptUrl: "" };
  }

  return {
    chargeId: String(latestCharge?.id || ""),
    receiptUrl: String(latestCharge?.receipt_url || ""),
  };
}

/**
 * Get Receipt URL by PaymentIntent ID
 */
export async function getReceiptUrlByPaymentIntent(paymentIntentId) {
  const pi = await retrievePaymentIntent(paymentIntentId);
  const { receiptUrl } = extractChargeAndReceiptFromPI(pi);
  return receiptUrl || "";
}

/**
 * Create Stripe Refund (full or partial)
 *
 * @param paymentIntentId - required
 * @param amountMajor - optional (ILS major). If omitted -> full refund.
 * @param reason - internal reason
 * @param idempotencyKey - optional
 */
export async function createStripeRefund({
  paymentIntentId,
  amountMajor,
  reason,
  idempotencyKey,
}) {
  const stripe = getStripe();

  if (!paymentIntentId) {
    throw makeErr(400, "MISSING_PAYMENT_INTENT", "paymentIntentId is required");
  }

  const amountMinor =
    typeof amountMajor === "number" || typeof amountMajor === "string"
      ? toMinorUnits(amountMajor)
      : null;

  const stripeReason = mapRefundReasonToStripe(reason);

  const params = {
    payment_intent: String(paymentIntentId),
    ...(amountMinor && amountMinor > 0 ? { amount: amountMinor } : {}),
    ...(stripeReason ? { reason: stripeReason } : {}),
  };

  const opts = idempotencyKey
    ? { idempotencyKey: String(idempotencyKey) }
    : undefined;

  try {
    const refund = await stripe.refunds.create(params, opts);
    return refund;
  } catch (e) {
    const msg = e?.message || "Stripe refund failed";
    const code = e?.code || "STRIPE_REFUND_FAILED";
    throw makeErr(502, code, msg);
  }
}

/**
 * Normalize Stripe refund into safe response
 * (store amount in ILS major)
 */
export function normalizeStripeRefund(refund) {
  return {
    stripeRefundId: String(refund?.id || ""),
    status: String(refund?.status || "unknown"),
    amount: fromMinorUnits(refund?.amount || 0),
    currency: String(refund?.currency || "ils").toLowerCase(),
    failureReason: String(refund?.failure_reason || ""),
  };
}
