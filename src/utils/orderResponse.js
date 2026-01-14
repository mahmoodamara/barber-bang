import { assertIntMinor, mapMoneyPairFromMinor, normalizeCurrency, toMajorUnits } from "./money.js";

export function formatOrderForResponse(order) {
  if (!order || typeof order !== "object") return order;

  const pricingCurrency = order.pricing?.currency;
  const paymentCurrency = order.payment?.currency;
  const currency = normalizeCurrency(pricingCurrency || paymentCurrency) || "ILS";
  const id = order.id ?? (order._id ? String(order._id) : undefined);
  const paymentStatus = String(order.payment?.status || "");
  const invoiceStatus =
    order.invoiceStatus && order.invoiceStatus !== "none"
      ? order.invoiceStatus
      : paymentStatus === "captured"
        ? "pending"
        : order.invoiceStatus || "none";

  const items = Array.isArray(order.items)
    ? order.items.map((it) => ({
        ...it,
        ...mapMoneyPairFromMinor(it.unitPrice, currency, "unitPrice", "unitPriceMinor"),
        ...mapMoneyPairFromMinor(it.lineTotal, currency, "lineTotal", "lineTotalMinor"),
      }))
    : order.items;

  const taxMinor = Number.isInteger(order.pricing?.taxMinor)
    ? order.pricing.taxMinor
    : Number.isInteger(order.pricing?.tax)
      ? order.pricing.tax
      : 0;
  assertIntMinor(taxMinor, "pricing.taxMinor");

  const pricing = order.pricing
    ? {
        ...order.pricing,
        currency,
        ...mapMoneyPairFromMinor(order.pricing.subtotal, currency, "subtotal", "subtotalMinor"),
        ...mapMoneyPairFromMinor(order.pricing.discountTotal, currency, "discountTotal", "discountTotalMinor"),
        discountBreakdown: order.pricing.discountBreakdown
          ? {
              ...mapMoneyPairFromMinor(order.pricing.discountBreakdown.couponMinor, currency, "coupon", "couponMinor"),
              ...mapMoneyPairFromMinor(
                order.pricing.discountBreakdown.promotionsMinor,
                currency,
                "promotions",
                "promotionsMinor",
              ),
            }
          : order.pricing.discountBreakdown,
        ...mapMoneyPairFromMinor(order.pricing.shipping, currency, "shipping", "shippingMinor"),
        tax: toMajorUnits(taxMinor, currency),
        taxMinor,
        ...mapMoneyPairFromMinor(order.pricing.grandTotal, currency, "grandTotal", "grandTotalMinor"),
      }
    : order.pricing;

  const payment = order.payment
    ? {
        provider: order.payment.provider,
        paidAt: order.payment.paidAt,
        ...mapMoneyPairFromMinor(
          order.payment.amountCaptured,
          order.payment.currency || currency,
          "amountCaptured",
          "amountCapturedMinor",
        ),
        currency: normalizeCurrency(order.payment.currency || currency),
      }
    : order.payment;

  const refund = order.refund
    ? {
        status: order.refund.status,
        ...mapMoneyPairFromMinor(order.refund.amountRefunded, currency, "amountRefunded", "amountRefundedMinor"),
        refundedAt: order.refund.refundedAt,
        restocked: order.refund.restocked,
      }
    : order.refund;

  const shippingMethod = order.shippingMethod
    ? {
        ...order.shippingMethod,
        ...mapMoneyPairFromMinor(order.shippingMethod.basePriceSnapshot, currency, "basePriceSnapshot", "basePriceSnapshotMinor"),
        ...mapMoneyPairFromMinor(order.shippingMethod.freeAboveSnapshot, currency, "freeAboveSnapshot", "freeAboveSnapshotMinor"),
        ...mapMoneyPairFromMinor(order.shippingMethod.computedPrice, currency, "computedPrice", "computedPriceMinor"),
      }
    : order.shippingMethod;

  const promotions = Array.isArray(order.promotions)
    ? order.promotions.map((p) => {
        const { discountMinor, ...rest } = p || {};
        const minor = Number.isInteger(discountMinor) ? discountMinor : 0;
        assertIntMinor(minor, "promotions.discountMinor");
        return {
          ...rest,
          discount: toMajorUnits(minor, currency),
          discountMinor: minor,
        };
      })
    : order.promotions;

  return {
    id,
    _id: order._id ?? id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    guestEmail: order.guestEmail,
    lang: order.lang,
    status: order.status,
    items,
    pricing,
    coupon: order.coupon
      ? {
          ...order.coupon,
          ...mapMoneyPairFromMinor(order.coupon.discountTotal, currency, "discountTotal", "discountTotalMinor"),
        }
      : order.coupon,
    promotionCode: order.promotionCode ?? null,
    promotions,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    shippingMethod,
    expiresAt: order.expiresAt,
    payment,
    invoiceStatus,
    invoiceRef: order.invoiceRef ?? null,
    invoiceUrl: order.invoiceUrl ?? null,
    invoiceIssuedAt: order.invoiceIssuedAt ?? null,
    stock: order.stock,
    tracking: order.tracking,
    trackingHistory: order.trackingHistory,
    fulfillment: order.fulfillment,
    cancel: order.cancel,
    refund,
    statusHistory: order.statusHistory,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
