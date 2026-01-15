// src/models/Order.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

/**
 * ORDER MODEL — Hardened (Phase 4+) with Phase 11 shippingMethod snapshot support
 * Goals:
 * - Money in minor units (int) to avoid floating errors
 * - Stronger invariants + safer defaults
 * - Cancel/Refund fields + expiry support
 * - Indexes optimized for user/admin queries + worker sweeps
 * - Avoid duplicate/invalid unique sparse indexes
 * - Add shippingMethod snapshot (Phase 11) without breaking existing docs
 */

function intMin0(v) {
  return Number.isInteger(v) && v >= 0;
}
function intMin1(v) {
  return Number.isInteger(v) && v >= 1;
}
function trimOrEmpty(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function trimOrNull(v) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s.length ? s : null;
}

const OrderItemSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    variantId: { type: Types.ObjectId, ref: "Variant", required: true, index: true },

    skuSnapshot: { type: String, trim: true, maxlength: 80, default: "" },

    nameHeSnapshot: { type: String, trim: true, maxlength: 180, default: "" },
    nameArSnapshot: { type: String, trim: true, maxlength: 180, default: "" },

    /**
     * Store monetary values as INTEGER minor units.
     * Example: 10.90 ILS -> 1090
     */
    unitPrice: {
      type: Number,
      required: true,
      validate: { validator: intMin0, message: "unitPrice must be an integer >= 0 (minor units)" },
    },
    quantity: {
      type: Number,
      required: true,
      validate: { validator: intMin1, message: "quantity must be an integer >= 1" },
    },
    lineTotal: {
      type: Number,
      required: true,
      validate: { validator: intMin0, message: "lineTotal must be an integer >= 0 (minor units)" },
    },
  },
  { _id: false },
);

const PricingSchema = new Schema(
  {
    currency: { type: String, trim: true, uppercase: true, default: "ILS", maxlength: 10 },

    subtotal: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "subtotal must be integer >= 0" },
    },
    discountTotal: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "discountTotal must be integer >= 0" },
    },
    discountBreakdown: {
      couponMinor: {
        type: Number,
        default: 0,
        validate: { validator: intMin0, message: "discountBreakdown.couponMinor must be integer >= 0" },
      },
      promotionsMinor: {
        type: Number,
        default: 0,
        validate: { validator: intMin0, message: "discountBreakdown.promotionsMinor must be integer >= 0" },
      },
    },
    shipping: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "shipping must be integer >= 0" },
    },

    /**
     * Tax/VAT (minor units) - backend computed.
     * Keep `tax` for backward compatibility with existing APIs.
     */
    tax: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "tax must be integer >= 0" },
    },
    taxMinor: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "taxMinor must be integer >= 0" },
    },
    taxRateBps: {
      type: Number,
      default: 0,
      validate: {
        validator: (v) => Number.isInteger(v) && v >= 0 && v <= 10_000,
        message: "taxRateBps must be integer between 0 and 10000",
      },
    },
    taxBasisMinor: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "taxBasisMinor must be integer >= 0" },
    },
    taxCountrySnapshot: { type: String, trim: true, uppercase: true, maxlength: 2, default: null },
    taxCitySnapshot: { type: String, trim: true, maxlength: 120, default: null },

    grandTotal: {
      type: Number,
      required: true,
      validate: { validator: intMin0, message: "grandTotal must be integer >= 0" },
    },
  },
  { _id: false },
);

const ActorSnapshotSchema = new Schema(
  {
    kind: { type: String, trim: true, maxlength: 30, default: "system" }, // user/admin/staff/system
    id: { type: Types.ObjectId, ref: "User", default: null },
    roles: { type: [String], default: [] },
    email: { type: String, trim: true, maxlength: 254, default: null },
  },
  { _id: false },
);

const RequestInfoSchema = new Schema(
  {
    requestId: { type: String, trim: true, maxlength: 120, default: null },
    ip: { type: String, trim: true, maxlength: 80, default: null },
    userAgent: { type: String, trim: true, maxlength: 300, default: null },
  },
  { _id: false },
);

// Status history v2 (append-only). Keeps legacy fields for backward compatibility.
const StatusHistorySchema = new Schema(
  {
    // v2 fields
    from: { type: String, trim: true, maxlength: 40, default: null },
    to: { type: String, trim: true, maxlength: 40, default: null },

    actor: { type: ActorSnapshotSchema, default: null },
    reason: { type: String, trim: true, maxlength: 300, default: "" },
    code: { type: String, trim: true, maxlength: 80, default: null },
    request: { type: RequestInfoSchema, default: null },
    meta: { type: Schema.Types.Mixed, default: null },

    // legacy fields (do not remove; older services may still push these)
    status: { type: String, required: true, trim: true, maxlength: 40 },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false },
);

const AdminNoteSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actorId: { type: Types.ObjectId, ref: "User", default: null },
    roles: { type: [String], default: [] },
    note: { type: String, trim: true, maxlength: 1000, required: true },
  },
  { _id: false },
);

const TrackingSchema = new Schema(
  {
    carrier: { type: String, trim: true, maxlength: 80, default: null },
    trackingNumber: { type: String, trim: true, maxlength: 120, default: null },
    trackingUrl: { type: String, trim: true, maxlength: 500, default: null },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

const TrackingHistorySchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: ActorSnapshotSchema, default: null },
    carrier: { type: String, trim: true, maxlength: 80, default: null },
    trackingNumber: { type: String, trim: true, maxlength: 120, default: null },
    trackingUrl: { type: String, trim: true, maxlength: 500, default: null },
    request: { type: RequestInfoSchema, default: null },
  },
  { _id: false },
);

const FulfillmentEventSchema = new Schema(
  {
    type: { type: String, trim: true, maxlength: 40, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const FulfillmentSchema = new Schema(
  {
    events: { type: [FulfillmentEventSchema], default: [] },
  },
  { _id: false },
);

const AddressSnapshotSchema = new Schema(
  {
    fullName: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 30, default: "" },

    country: { type: String, trim: true, maxlength: 80, default: "" },
    city: { type: String, trim: true, maxlength: 120, default: "" },
    street: { type: String, trim: true, maxlength: 200, default: "" },

    building: { type: String, trim: true, maxlength: 50, default: "" },
    apartment: { type: String, trim: true, maxlength: 50, default: "" },
    zip: { type: String, trim: true, maxlength: 30, default: "" },

    notes: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false },
);

const PromotionSnapshotSchema = new Schema(
  {
    promotionId: { type: Types.ObjectId, ref: "Promotion", required: true },
    nameSnapshot: { type: String, trim: true, maxlength: 120, default: "" },
    codeSnapshot: { type: String, trim: true, uppercase: true, maxlength: 60, default: null },
    type: { type: String, trim: true, maxlength: 30, default: null },
    discountMinor: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "promotions.discountMinor must be integer >= 0" },
    },
    prioritySnapshot: { type: Number, default: 0 },
    stackingPolicySnapshot: { type: String, trim: true, maxlength: 40, default: null },
  },
  { _id: false },
);

// Phase 11 snapshot (added safely; optional, default null)
const ShippingMethodSnapshotSchema = new Schema(
  {
    shippingMethodId: { type: Types.ObjectId, ref: "ShippingMethod", default: null },

    code: { type: String, trim: true, maxlength: 50, default: null },

    nameHeSnapshot: { type: String, trim: true, maxlength: 120, default: "" },
    nameArSnapshot: { type: String, trim: true, maxlength: 120, default: "" },

    basePriceSnapshot: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "shippingMethod.basePriceSnapshot must be integer >= 0" },
    },
    freeAboveSnapshot: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v === null || intMin0(v),
        message: "shippingMethod.freeAboveSnapshot must be null or integer >= 0",
      },
    },
    computedPrice: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "shippingMethod.computedPrice must be integer >= 0" },
    },
  },
  { _id: false },
);

const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "payment_received",
  "stock_confirmed",
  "paid", // legacy (treated as confirmed)
  "fulfilled",
  "cancelled",
  "partially_refunded",
  "refunded",
];

const STOCK_STATUSES = [
  "none",
  "reserved",
  "released",
  "confirmed",
  "confirm_failed",
];

const OrderSchema = new Schema(
  {
    orderNumber: { type: String, trim: true, maxlength: 40 },

    userId: { type: Types.ObjectId, ref: "User", default: null },
    guestEmail: { type: String, trim: true, maxlength: 254, default: null },

    lang: { type: String, enum: ["he", "ar"], default: "he" },

    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: "draft",
      index: true,
    },

    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: ActorSnapshotSchema, default: null },

    items: { type: [OrderItemSchema], default: [] },
    pricing: { type: PricingSchema, required: true },

    coupon: {
      code: { type: String, trim: true, maxlength: 60, default: null },
      discountTotal: {
        type: Number,
        default: 0,
        validate: { validator: intMin0, message: "coupon.discountTotal must be integer >= 0" },
      },
      meta: { type: Schema.Types.Mixed, default: {} },
    },
    promotionCode: { type: String, trim: true, uppercase: true, maxlength: 60, default: null },
    promotions: { type: [PromotionSnapshotSchema], default: [] },

    shippingAddress: { type: AddressSnapshotSchema, default: null },
    billingAddress: { type: AddressSnapshotSchema, default: null },

    // Phase 11: shipping method snapshot (optional)
    shippingMethod: { type: ShippingMethodSnapshotSchema, default: null },

    /**
     * Stock reservation/confirmation state (per-order ownership)
     * - reserved: stockReserved incremented
     * - confirmed: stock + stockReserved decremented
     */
    stock: {
      status: { type: String, enum: STOCK_STATUSES, default: "none" },
      reservedAt: { type: Date, default: null },
      confirmedAt: { type: Date, default: null },
      releasedAt: { type: Date, default: null },
      confirmAttempts: { type: Number, default: 0 },
      lastError: { type: String, trim: true, maxlength: 200, default: null },
    },

    /**
     * Expire flow:
     * Worker cancels orders that passed expiresAt while pending_payment.
     */
    expiresAt: { type: Date, default: null, index: true },

    payment: {
      provider: { type: String, trim: true, maxlength: 30, default: "stripe" }, // stripe/tranzila
      stripeSessionId: { type: String, trim: true, maxlength: 200, default: null },
      stripePaymentIntentId: { type: String, trim: true, maxlength: 200, default: null },
      paidAt: { type: Date, default: null },

      amountCaptured: {
        type: Number,
        default: null,
        validate: {
          validator: (v) => v === null || intMin0(v),
          message: "payment.amountCaptured must be integer >= 0",
        },
      },
      currency: { type: String, trim: true, uppercase: true, maxlength: 10, default: null },

      status: {
        type: String,
        enum: ["pending", "captured", "mismatch", "requires_refund"],
        default: "pending",
      },
      checkoutAmount: {
        type: Number,
        default: null,
        validate: {
          validator: (v) => v === null || intMin0(v),
          message: "payment.checkoutAmount must be integer >= 0",
        },
      },
      checkoutCurrency: { type: String, trim: true, uppercase: true, maxlength: 10, default: null },
      lastError: { type: String, trim: true, maxlength: 200, default: null },
    },

    invoiceStatus: {
      type: String,
      enum: ["none", "pending", "issued", "failed"],
      default: "none",
    },
    invoiceRef: { type: String, trim: true, maxlength: 120, default: null },
    invoiceUrl: { type: String, trim: true, maxlength: 2000, default: null },
    invoiceIssuedAt: { type: Date, default: null },

    cancel: {
      canceledAt: { type: Date, default: null },
      canceledBy: { type: String, enum: ["user", "system", "admin"], default: null },
      reason: { type: String, trim: true, maxlength: 300, default: "" },
    },

    refund: {
      status: { type: String, enum: ["none", "partial", "full", "chargeback"], default: "none" },
      amountRefunded: {
        type: Number,
        default: 0,
        validate: { validator: intMin0, message: "refund.amountRefunded must be integer >= 0" },
      },
      refundedAt: { type: Date, default: null },
      restocked: { type: Boolean, default: false },
      lastStripeRefundId: { type: String, trim: true, maxlength: 200, default: null },
    },

    tracking: { type: TrackingSchema, default: null },
    trackingHistory: { type: [TrackingHistorySchema], default: [] },
    adminNotes: { type: [AdminNoteSchema], default: [] },

    fulfillment: { type: FulfillmentSchema, default: null },

    statusHistory: { type: [StatusHistorySchema], default: [] },
  },
  { timestamps: true, strict: true },
);

/**
 * INVARIANTS / SECURITY:
 * - Either userId OR guestEmail must exist.
 * - Prevent impossible states.
 * - Enforce item totals and pricing totals.
 * - Keep discount snapshots consistent with pricing.discountTotal.
 */
OrderSchema.pre("validate", function preValidate(next) {
  const isSnapshotLocked = () => {
    const status = String(this.status || "");
    const hardLocked = new Set([
      "stock_confirmed",
      "paid",
      "fulfilled",
      "partially_refunded",
      "refunded",
    ]);
    if (hardLocked.has(status)) return true;
    if (status === "payment_received") {
      // Lock only when payment is actually captured (not mismatch/exception flows)
      return String(this.payment?.status || "") === "captured";
    }
    return false;
  };

  if (!this.isNew && isSnapshotLocked()) {
    const lockedPaths = [
      "items",
      "coupon",
      "promotions",
      "promotionCode",
      "shippingAddress",
      "billingAddress",
      "shippingMethod",
      "pricing.currency",
      "pricing.subtotal",
      "pricing.discountTotal",
      "pricing.discountBreakdown",
      "pricing.shipping",
      "pricing.tax",
      "pricing.taxMinor",
      "pricing.taxRateBps",
      "pricing.taxBasisMinor",
      "pricing.taxCountrySnapshot",
      "pricing.taxCitySnapshot",
      "pricing.grandTotal",
    ];

    const modified = lockedPaths.filter((p) => this.isModified(p));
    if (modified.length) {
      const err = new Error("ORDER_SNAPSHOTS_LOCKED");
      err.statusCode = 409;
      err.code = "ORDER_SNAPSHOTS_LOCKED";
      err.details = { modified };
      return next(err);
    }
  }

  // Normalize guestEmail empty -> null (prevents " " from satisfying invariant)
  this.guestEmail = trimOrNull(this.guestEmail);
  if (this.promotionCode) this.promotionCode = String(this.promotionCode).trim().toUpperCase();
  if (!this.promotionCode) this.promotionCode = null;

  // user or guest must exist
  if (!this.userId && !this.guestEmail) {
    this.invalidate("userId", "Either userId or guestEmail is required");
  }

  // normalize lang
  if (this.lang !== "he" && this.lang !== "ar") this.lang = "he";

  // Ensure line totals are consistent + subtotal is computed from items
  const items = Array.isArray(this.items) ? this.items : [];
  let computedSubtotal = 0;

  for (const it of items) {
    const unitPrice = Number.isInteger(it.unitPrice) ? it.unitPrice : 0;
    const qty = Number.isInteger(it.quantity) ? it.quantity : 0;

    const expected = unitPrice * qty;
    if (Number.isInteger(expected) && it.lineTotal !== expected) {
      it.lineTotal = expected;
    }
    computedSubtotal += Number.isInteger(it.lineTotal) ? it.lineTotal : 0;
  }

  // pricing defaults
  if (!this.pricing) this.pricing = { currency: "ILS", grandTotal: 0 };
  if (!Number.isInteger(this.pricing.subtotal) || this.pricing.subtotal !== computedSubtotal) {
    this.pricing.subtotal = computedSubtotal;
  }

  // Keep discount snapshots aligned with pricing.discountTotal (avoid drift)
  const couponDisc = Number.isInteger(this.coupon?.discountTotal) ? this.coupon.discountTotal : 0;
  if (!this.coupon) this.coupon = { code: null, discountTotal: 0, meta: {} };
  if (!Array.isArray(this.promotions)) this.promotions = [];

  let promosDisc = 0;
  for (const p of this.promotions) {
    const d = Number.isInteger(p?.discountMinor) && p.discountMinor >= 0 ? p.discountMinor : 0;
    if (p) p.discountMinor = d;
    promosDisc += d;
  }

  if (!this.pricing.discountBreakdown) this.pricing.discountBreakdown = { couponMinor: 0, promotionsMinor: 0 };
  this.pricing.discountBreakdown.couponMinor = couponDisc;
  this.pricing.discountBreakdown.promotionsMinor = promosDisc;

  const totalDiscount = couponDisc + promosDisc;
  if (!Number.isInteger(this.pricing.discountTotal) || this.pricing.discountTotal !== totalDiscount) {
    this.pricing.discountTotal = totalDiscount;
  }

  // If coupon present, pricing.discountTotal should reflect it; if no coupon, it should be 0
  const hasCoupon = !!(this.coupon.code && String(this.coupon.code).trim().length);
  if (hasCoupon) {
    if (this.coupon.discountTotal !== couponDisc) this.coupon.discountTotal = couponDisc;
  } else {
    if (this.coupon.code !== null) this.coupon.code = null;
    if (this.coupon.discountTotal !== 0) this.coupon.discountTotal = 0;
  }

  // Tax compatibility normalization:
  // - taxMinor is the canonical stored value; pricing.tax remains for legacy clients
  if (!Number.isInteger(this.pricing.taxMinor)) {
    this.pricing.taxMinor = Number.isInteger(this.pricing.tax) ? this.pricing.tax : 0;
  }
  if (!Number.isInteger(this.pricing.tax)) {
    this.pricing.tax = this.pricing.taxMinor;
  } else if (this.pricing.tax !== this.pricing.taxMinor) {
    this.pricing.tax = this.pricing.taxMinor;
  }

  if (!Number.isInteger(this.pricing.taxRateBps) || this.pricing.taxRateBps < 0 || this.pricing.taxRateBps > 10_000) {
    this.pricing.taxRateBps = 0;
  }
  if (!Number.isInteger(this.pricing.taxBasisMinor) || this.pricing.taxBasisMinor < 0) {
    this.pricing.taxBasisMinor = 0;
  }
  this.pricing.taxCountrySnapshot = trimOrNull(this.pricing.taxCountrySnapshot);
  if (this.pricing.taxCountrySnapshot && this.pricing.taxCountrySnapshot.length > 2) {
    this.pricing.taxCountrySnapshot = this.pricing.taxCountrySnapshot.slice(0, 2);
  }
  this.pricing.taxCitySnapshot = trimOrNull(this.pricing.taxCitySnapshot);

  // Normalize pricing numbers
  const discount = Number.isInteger(this.pricing.discountTotal) ? this.pricing.discountTotal : 0;
  // Ensure shippingMethod.computedPrice mirrors pricing.shipping when present (snapshot consistency)
  if (this.shippingMethod && this.shippingMethod.shippingMethodId) {
    const sp = Number.isInteger(this.shippingMethod.computedPrice) ? this.shippingMethod.computedPrice : 0;
    if (this.pricing.shipping !== sp) this.pricing.shipping = sp;
    this.shippingMethod.code = trimOrNull(this.shippingMethod.code);
    this.shippingMethod.nameHeSnapshot = trimOrEmpty(this.shippingMethod.nameHeSnapshot);
    this.shippingMethod.nameArSnapshot = trimOrEmpty(this.shippingMethod.nameArSnapshot);
  } else if (this.shippingMethod && !this.shippingMethod.shippingMethodId) {
    // clean empty object
    this.shippingMethod = null;
  }

  const shipping = Number.isInteger(this.pricing.shipping) ? this.pricing.shipping : 0;
  const tax = Number.isInteger(this.pricing.taxMinor) ? this.pricing.taxMinor : 0;

  const computedGrand = Math.max(0, computedSubtotal - discount + shipping + tax);
  if (!Number.isInteger(this.pricing.grandTotal) || this.pricing.grandTotal !== computedGrand) {
    this.pricing.grandTotal = computedGrand;
  }

  // Status-derived defaults
  if (this.status === "pending_payment" && !this.expiresAt) {
    // default expiry window: 20 minutes (override in service layer if needed)
    this.expiresAt = new Date(Date.now() + 20 * 60_000);
  }

  const statusChanged = this.isNew || this.isModified("status");
  if (statusChanged) {
    if (!this.statusChangedAt) this.statusChangedAt = new Date();
    if (!this.statusChangedBy) this.statusChangedBy = { kind: "system", id: null, roles: [], email: null };
  }

  if (statusChanged && this.status === "pending_payment") {
    this.stock = this.stock || {};
    if (!this.stock.status) {
      this.stock.status = "reserved";
      this.stock.reservedAt = this.stock.reservedAt || new Date();
    }
    if (this.stock.status !== "reserved") {
      this.invalidate("stock.status", "pending_payment requires stock.status=reserved");
    }
  }

  // Payment received implies paidAt
  if (
    statusChanged &&
    (this.status === "payment_received" || this.status === "stock_confirmed" || this.status === "paid")
  ) {
    if (!this.payment?.paidAt) {
      this.invalidate("payment.paidAt", "payment_received requires payment.paidAt");
    }
  }

  const paymentStatus = String(this.payment?.status || "");
  if (paymentStatus === "captured") {
    if (!this.invoiceStatus || this.invoiceStatus === "none") {
      this.invoiceStatus = "pending";
    }
  }
  this.invoiceRef = trimOrNull(this.invoiceRef);
  this.invoiceUrl = trimOrNull(this.invoiceUrl);

  // Stock confirmed requires confirmed stock
  if (statusChanged && (this.status === "stock_confirmed" || this.status === "paid")) {
    if (this.stock?.status !== "confirmed") {
      this.invalidate("stock.status", "stock_confirmed requires stock.status=confirmed");
    }
  }

  // Cancelled implies cancel fields
  if (this.status === "cancelled" && !this.cancel?.canceledAt) {
    this.cancel = this.cancel || {};
    this.cancel.canceledAt = new Date();
    if (!this.cancel.canceledBy) this.cancel.canceledBy = "system";
  }

  // Refunded states imply refund fields
  if ((this.status === "refunded" || this.status === "partially_refunded") && !this.refund) {
    this.refund = { status: this.status === "refunded" ? "full" : "partial", amountRefunded: 0 };
  }

  next();
});

/**
 * INDEXES
 * Notes:
 * - orderNumber unique sparse is OK if you generate it.
 * - Do NOT define duplicate indexes in schema fields + here (avoid Mongoose duplicate warnings).
 */
OrderSchema.index({ orderNumber: 1 }, { unique: true, sparse: true });

// Fast user/admin queries
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1, _id: -1 });
OrderSchema.index({ createdAt: -1, _id: -1 });

// Worker sweep: pending_payment expired
OrderSchema.index({ status: 1, expiresAt: 1 });
OrderSchema.index({ status: 1, "stock.status": 1, updatedAt: -1 });

// Admin reporting
OrderSchema.index({ status: 1, "payment.paidAt": -1 });
OrderSchema.index({ "payment.stripePaymentIntentId": 1 }, { sparse: true });
OrderSchema.index({ "payment.stripeSessionId": 1 }, { sparse: true });

// Optional: coupon code lookup (helps reporting / customer support)
OrderSchema.index({ "coupon.code": 1 }, { sparse: true });

// Optional: guest email lookup
OrderSchema.index({ guestEmail: 1, createdAt: -1 }, { sparse: true });

// Optional: support search by customer phone (partial index; avoids indexing empty strings)
OrderSchema.index({ "shippingAddress.phone": 1 });
OrderSchema.index(
  { "shippingAddress.phone": 1, createdAt: -1 },
  {
    name: "order_shipping_phone_createdAt",
    partialFilterExpression: { "shippingAddress.phone": { $exists: true, $ne: "" } },
  },
);

OrderSchema.index(
  { "billingAddress.phone": 1, createdAt: -1 },
  {
    name: "order_billing_phone_createdAt",
    partialFilterExpression: { "billingAddress.phone": { $exists: true, $ne: "" } },
  },
);

baseToJSON(OrderSchema);

export const Order = getOrCreateModel("Order", OrderSchema);
export default Order;
