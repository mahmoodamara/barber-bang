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
      index: true,
    },

    // ✅ bilingual titles
    titleHe: { type: String, default: "" },
    titleAr: { type: String, default: "" },

    // ✅ legacy-safe unified title
    title: { type: String, default: "" },

    unitPrice: { type: Number, required: true, min: 0 }, // ILS major
    qty: { type: Number, required: true, min: 1, max: 999 },

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
  },
  { _id: false }
);

/**
 * Gift items (free items)
 */
const giftItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },

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

    // ✅ additive legacy fields (safe)
    discountTotal: { type: Number, default: 0, min: 0 },
    couponCode: { type: String, default: "" },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
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

    // ✅ root phone
    phone: { type: String, default: "" },

    address: {
      fullName: { type: String, default: "" },

      // ✅ also store phone in address (legacy-safe)
      phone: { type: String, default: "" },

      city: { type: String, default: "" },
      street: { type: String, default: "" },
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
      index: true,
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
      index: true,
    },
    docId: { type: String, default: "" },
    number: { type: String, default: "" },
    url: { type: String, default: "" },
    issuedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "issued", "failed"],
      default: "pending",
      index: true,
    },
    error: { type: String, default: "" },

    // Optional B2B fields
    customerVatId: { type: String, default: "" },
    customerCompanyName: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * Cancellation metadata
 */
const cancellationSchema = new mongoose.Schema(
  {
    requested: { type: Boolean, default: false, index: true },
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
      index: true,
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
      index: true,
    },
  },
  { _id: false }
);

/**
 * Idempotency keys (prevents duplicates)
 */
const idempotencySchema = new mongoose.Schema(
  {
    checkoutKey: { type: String, default: "", index: true },
    refundKey: { type: String, default: "", index: true },
    cancelKey: { type: String, default: "", index: true },
    returnKey: { type: String, default: "", index: true },
  },
  { _id: false }
);

/* ============================
   Main Order Schema
============================ */

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

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
      index: true,
    },

    paymentMethod: { type: String, enum: ["stripe", "cod"], required: true, index: true },

    // ✅ Source of truth pricing
    pricing: { type: pricingSchema, required: true },

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

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

orderSchema.index({ paymentMethod: 1, createdAt: -1 });

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
