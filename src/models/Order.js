// src/models/Order.js
import mongoose from "mongoose";

/* ============================
   Sub-schemas
============================ */

/**
 * Order Item (ILS major units)
 * - Keep bilingual titles for receipts + history
 */
const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // ✅ bilingual titles
    titleHe: { type: String, default: "" },
    titleAr: { type: String, default: "" },

    // ✅ legacy-safe unified title
    title: { type: String, default: "" },

    unitPrice: { type: Number, required: true, min: 0 }, // ILS major
    qty: { type: Number, required: true, min: 1, max: 999 },

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },

    // Variant selection (optional)
    variantId: { type: String, default: "" },
    variantSnapshot: {
      variantId: { type: String, default: "" },
      sku: { type: String, default: "" },
      price: { type: Number, default: 0, min: 0 }, // ILS major
      priceMinor: { type: Number, default: 0, min: 0 },
      attributesList: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, default: "" },
              type: { type: String, default: "" },
              value: { type: mongoose.Schema.Types.Mixed, default: null },
              valueKey: { type: String, default: "" },
              unit: { type: String, default: "" },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
      attributes: {
        volumeMl: { type: Number, default: null, min: 0 },
        weightG: { type: Number, default: null, min: 0 },
        packCount: { type: Number, default: null, min: 0 },
        scent: { type: String, default: "" },
        holdLevel: { type: String, default: "" },
        finishType: { type: String, default: "" },
        skinType: { type: String, default: "" },
      },
    },
  },
  { _id: false }
);

/**
 * Gift items (free items)
 * ✅ Updated to support variant gifts
 */
const giftItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // ✅ Support for variant gifts (BUY_X_GET_Y with getVariantId)
    variantId: { type: String, default: "" },

    titleHe: { type: String, default: "" },
    titleAr: { type: String, default: "" },
    title: { type: String, default: "" },

    qty: { type: Number, required: true, min: 1, max: 50, default: 1 },
  },
  { _id: false }
);

/**
 * ✅ Pricing contract aligned with quotePricing()
 * Amounts are ILS major (Number)
 */
const pricingSchema = new mongoose.Schema(
  {
    subtotal: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, required: true, min: 0 },

    discounts: {
      coupon: {
        code: { type: String, default: null }, // normalized uppercase by service
        amount: { type: Number, default: 0, min: 0 },
      },
      campaign: {
        amount: { type: Number, default: 0, min: 0 },
      },
      offer: {
        amount: { type: Number, default: 0, min: 0 },
      },
    },

    total: { type: Number, required: true, min: 0 },

    // VAT fields are in ILS major units (aligned with pricing)
    vatRate: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    totalBeforeVat: { type: Number, default: 0, min: 0 },
    totalAfterVat: { type: Number, default: 0, min: 0 },
    vatIncludedInPrices: { type: Boolean, default: false },

    // Minor-unit mirrors (ILS agorot)
    subtotalMinor: { type: Number, default: 0, min: 0 },
    shippingFeeMinor: { type: Number, default: 0, min: 0 },
    discountTotalMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, default: 0, min: 0 },
    vatAmountMinor: { type: Number, default: 0, min: 0 },
    totalBeforeVatMinor: { type: Number, default: 0, min: 0 },
    totalAfterVatMinor: { type: Number, default: 0, min: 0 },

    // ✅ additive legacy fields (safe)
    discountTotal: { type: Number, default: 0, min: 0 },
    couponCode: { type: String, default: "" },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
  },
  { _id: false }
);

/**
 * Pricing in minor units (agorot) for audit safety
 */
const pricingMinorSchema = new mongoose.Schema(
  {
    subtotal: { type: Number, default: 0, min: 0 },
    shippingFee: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    totalBeforeVat: { type: Number, default: 0, min: 0 },
    totalAfterVat: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/**
 * Shipping info for fulfillment + guest tracking
 * - mode: DELIVERY | PICKUP_POINT | STORE_PICKUP
 */
const shippingSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"],
      required: true,
    },

    deliveryAreaId: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryArea", default: null },
    pickupPointId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupPoint", default: null },

    // Immutable snapshots (avoid historical drift)
    deliveryAreaName: { type: String, default: "" },
    pickupPointName: { type: String, default: "" },
    pickupPointAddress: { type: String, default: "" },

    // ✅ Shipping carrier and tracking
    carrier: { type: String, default: "" },
    trackingNumber: { type: String, default: "" },

    // ✅ root phone
    phone: { type: String, default: "" },

    address: {
      fullName: { type: String, default: "" },

      // ✅ also store phone in address (legacy-safe)
      phone: { type: String, default: "" },

      city: { type: String, default: "" },
      street: { type: String, default: "" },

      // ✅ Extended address fields for checkout
      building: { type: String, default: "" },
      floor: { type: String, default: "" },
      apartment: { type: String, default: "" },
      entrance: { type: String, default: "" },

      notes: { type: String, default: "" },
    },
  },
  { _id: false }
);


/**
 * Stripe references
 */
const stripeSchema = new mongoose.Schema(
  {
    sessionId: { type: String, default: "" },
    paymentIntentId: { type: String, default: "" },

    // ✅ extra fields for refunds/receipts
    chargeId: { type: String, default: "" },
    receiptUrl: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * Refund object (stored in ILS major)
 */
const refundSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["none", "pending", "succeeded", "failed"],
      default: "none",
    },

    amount: { type: Number, default: 0, min: 0 }, // ILS major
    currency: { type: String, default: "ils" },

    reason: {
      type: String,
      enum: ["customer_cancel", "return", "out_of_stock", "fraud", "duplicate", "other"],
      default: "other",
    },

    stripeRefundId: { type: String, default: "" },
    failureCode: { type: String, default: "" },
    failureMessage: { type: String, default: "" },

    requestedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Invoice metadata (optional)
 */
const invoiceSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["none", "stripe", "manual", "icount", "greeninvoice", "other"],
      default: "none",
    },
    docId: { type: String, default: "" },
    providerDocId: { type: String, default: "" },
    idempotencyKey: { type: String, default: "" },
    docType: { type: String, enum: ["", "invoice", "receipt_link", "other"], default: "" },
    number: { type: String, default: "" },
    url: { type: String, default: "" },
    issuedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "issuing", "issued", "failed"],
      default: "pending",
    },
    issuingAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
    error: { type: String, default: "" },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // Optional B2B fields
    customerVatId: { type: String, default: "" },
    customerCompanyName: { type: String, default: "" },

    allocation: {
      required: { type: Boolean, default: false },
      status: { type: String, enum: ["none", "pending", "issued", "failed"], default: "none" },
      number: { type: String, default: "" },
      thresholdBeforeVat: { type: Number, default: 0, min: 0 },
      requestedAt: { type: Date, default: null },
      issuedAt: { type: Date, default: null },
      error: { type: String, default: "" },
    },
  },
  { _id: false }
);

/**
 * Cancellation metadata
 */
const cancellationSchema = new mongoose.Schema(
  {
    requested: { type: Boolean, default: false },
    requestedAt: { type: Date, default: null },

    requestedBy: { type: String, enum: ["user", "admin", "system"], default: "user" },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ["user", "admin", "system"], default: "user" },
    reason: { type: String, default: "" },

    feeAmount: { type: Number, default: 0, min: 0 }, // ILS major
  },
  { _id: false }
);

/**
 * ✅ Legacy embedded return (keep for compatibility)
 * NOTE: New system uses ReturnRequest collection,
 * but this minimal embedded object stays to avoid breaking old UI/logic.
 */
const returnSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["none", "requested", "approved", "rejected", "received", "refunded"],
      default: "none",
    },

    requestedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },

    reason: { type: String, default: "" },

    items: {
      type: [
        new mongoose.Schema(
          {
            productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
            qty: { type: Number, required: true, min: 1, max: 999 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: false }
);

/**
 * ✅ ReturnRequest reference (new workflow)
 * If you use ReturnRequest model, link it here.
 */
const returnRequestRefSchema = new mongoose.Schema(
  {
    returnRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReturnRequest",
      default: null,
    },
  },
  { _id: false }
);

/**
 * Idempotency keys (prevents duplicates)
 */
const idempotencySchema = new mongoose.Schema(
  {
    checkoutKey: { type: String, default: "" },
    refundKey: { type: String, default: "" },
    cancelKey: { type: String, default: "" },
    returnKey: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * Webhook processing lock (single-writer guard)
 */
const webhookSchema = new mongoose.Schema(
  {
    lockId: { type: String, default: "" },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Analytics / stats (idempotent counters)
 */
const analyticsSchema = new mongoose.Schema(
  {
    salesCountedAt: { type: Date, default: null },
    salesCountedStatus: { type: String, default: "" },
    salesCountedUnits: { type: Number, default: 0 },
    salesCountedRevenueMinor: { type: Number, default: 0 },
    refundCountedAt: { type: Date, default: null },
    refundCountedAmountMinor: { type: Number, default: 0 },
    refundCountedReason: { type: String, default: "" },
  },
  { _id: false }
);

const couponReservationSchema = new mongoose.Schema(
  {
    code: { type: String, default: "" },
    status: {
      type: String,
      enum: ["none", "reserved", "consumed", "released", "expired"],
      default: "none",
    },
    reservedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
);

/* ============================
   Main Order Schema
============================ */

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Optional: short readable order number (safe to add)
    orderNumber: { type: String, default: "" },

    currency: { type: String, default: "ils" },

    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "Order must have at least one item.",
      },
    },

    gifts: { type: [giftItemSchema], default: [] },

    /**
     * ✅ Status (aligned with server)
     */
    status: {
      type: String,
      enum: [
        // Stripe lifecycle
        "pending_payment",
        "paid",
        "payment_received",
        "stock_confirmed",
        "confirmed",
        "shipped",
        "delivered",

        // COD lifecycle
        "pending_cod",
        "cod_pending_approval",

        // Return / refund lifecycle
        "return_requested",
        "refund_pending",
        "partially_refunded",
        "refunded",

        // common
        "cancelled",
      ],
      default: "pending_payment",
    },

    paidAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    paymentMethod: { type: String, enum: ["stripe", "cod"], required: true },

    // ✅ Source of truth pricing
    pricing: { type: pricingSchema, required: true },
    pricingMinor: { type: pricingMinorSchema, default: () => ({}) },

    // ✅ Shipping for tracking + fulfillment
    shipping: { type: shippingSchema, required: true },

    // Stripe refs
    stripe: { type: stripeSchema, default: () => ({}) },

    /**
     * ✅ Compliance / operational fields
     */
    refund: { type: refundSchema, default: () => ({}) },
    invoice: { type: invoiceSchema, default: () => ({}) },
    cancellation: { type: cancellationSchema, default: () => ({}) },

    // Legacy embedded return
    return: { type: returnSchema, default: () => ({}) },

    // New return reference
    returnRef: { type: returnRequestRefSchema, default: () => ({}) },

    /**
     * ✅ Idempotency keys used in operations
     */
    idempotency: { type: idempotencySchema, default: () => ({}) },

    /**
     * ✅ Analytics / idempotent counters
     */
    analytics: { type: analyticsSchema, default: () => ({}) },

    /**
     * ✅ Webhook processing lock
     */
    webhook: { type: webhookSchema, default: () => ({}) },

    /**
     * Coupon reservation (Stripe checkout)
     */
    couponReservation: { type: couponReservationSchema, default: () => ({}) },

    /**
     * Internal notes (admin/support)
     */
    internalNote: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ============================
   Virtuals (Legacy compatibility)
============================ */

orderSchema.virtual("subtotal").get(function subtotalVirtual() {
  return this?.pricing?.subtotal ?? 0;
});

orderSchema.virtual("shippingFee").get(function shippingFeeVirtual() {
  return this?.pricing?.shippingFee ?? 0;
});

orderSchema.virtual("total").get(function totalVirtual() {
  return this?.pricing?.total ?? 0;
});

/**
 * Legacy convenience: couponCode and discountTotal
 */
orderSchema.virtual("couponCode").get(function couponCodeVirtual() {
  return this?.pricing?.discounts?.coupon?.code ?? this?.pricing?.couponCode ?? "";
});

orderSchema.virtual("discountTotal").get(function discountTotalVirtual() {
  const d = this?.pricing?.discounts ?? {};
  const coupon = d?.coupon?.amount ?? 0;
  const campaign = d?.campaign?.amount ?? 0;
  const offer = d?.offer?.amount ?? 0;
  return Math.max(0, coupon + campaign + offer);
});

/* ============================
   Hooks (Data hygiene)
============================ */

/**
 * Ensure legacy title field is always filled when bilingual exists.
 * Ensure root phone mirrors address.phone to avoid inconsistent tracking.
 */
orderSchema.pre("validate", function normalizeOrderFields(next) {
  try {
    // items titles
    if (Array.isArray(this.items)) {
      this.items = this.items.map((it) => {
        if (!it) return it;
        if (!it.title && (it.titleHe || it.titleAr)) it.title = it.titleHe || it.titleAr || "";
        return it;
      });
    }

    // gifts titles
    if (Array.isArray(this.gifts)) {
      this.gifts = this.gifts.map((it) => {
        if (!it) return it;
        if (!it.title && (it.titleHe || it.titleAr)) it.title = it.titleHe || it.titleAr || "";
        return it;
      });
    }

    // shipping phone mirroring
    const addrPhone = String(this?.shipping?.address?.phone || "").trim();
    const rootPhone = String(this?.shipping?.phone || "").trim();

    if (!rootPhone && addrPhone) this.shipping.phone = addrPhone;
    if (!addrPhone && rootPhone && this.shipping?.address) this.shipping.address.phone = rootPhone;

    // pricing legacy fields (defense-in-depth)
    const couponCode = String(this?.pricing?.discounts?.coupon?.code || "").trim();
    const couponAmt = Number(this?.pricing?.discounts?.coupon?.amount || 0);
    const campAmt = Number(this?.pricing?.discounts?.campaign?.amount || 0);
    const offerAmt = Number(this?.pricing?.discounts?.offer?.amount || 0);

    this.pricing.discountTotal = Math.max(0, couponAmt + campAmt + offerAmt);
    if (couponCode) this.pricing.couponCode = couponCode;

    next();
  } catch (e) {
    next(e);
  }
});

/* ============================
   Indexes
============================ */

// User orders list
orderSchema.index({ userId: 1, createdAt: -1 });

// Admin listing by status
orderSchema.index({ status: 1, createdAt: -1 });

// Admin listing by payment method
orderSchema.index({ paymentMethod: 1, createdAt: -1 });

// General listing (createdAt only for admin list with no filters)
orderSchema.index({ createdAt: -1 });

orderSchema.index(
  { orderNumber: 1 },
  { unique: true, partialFilterExpression: { orderNumber: { $type: "string", $ne: "" } } }
);

/**
 * helpful for guest tracking
 */
orderSchema.index({ "shipping.phone": 1, createdAt: -1 });

/**
 * refunds ops
 */
orderSchema.index({ "refund.status": 1, createdAt: -1 });
orderSchema.index({ "invoice.provider": 1, createdAt: -1 });

/**
 * ReturnRequest link
 */
orderSchema.index({ "returnRef.returnRequestId": 1 }, { sparse: true });

/**
 * idempotency lookups (sparse to reduce index weight)
 */
orderSchema.index({ "idempotency.checkoutKey": 1 }, { sparse: true });
orderSchema.index({ "idempotency.refundKey": 1 }, { sparse: true });
orderSchema.index({ "idempotency.cancelKey": 1 }, { sparse: true });
orderSchema.index({ "idempotency.returnKey": 1 }, { sparse: true });

export const Order = mongoose.model("Order", orderSchema);
