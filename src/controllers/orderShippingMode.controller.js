// src/controllers/orderShippingMode.controller.js
import { Order } from "../models/Order.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import {
  SHIPPING_MODES,
  validateShippingMode,
  buildPaymentMethodsForMode,
} from "../services/shippingMode.service.js";
import { repriceOrder } from "../services/reprice.service.js";
import { quoteOrder } from "../services/orderQuote.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function ensureEditableStatus(order) {
  const status = String(order?.status || "");
  if (status === "draft" || status === "pending_payment") return;
  throw httpError(409, "ORDER_NOT_EDITABLE", "Order is not editable", { status });
}

/**
 * POST /orders/:id/shipping-mode
 * Set shipping mode for an order (new 3-mode system)
 */
export async function setOrderShippingMode(req, res) {
  const { id: orderId } = req.params;
  const userId = req.user?.id;
  const lang = req.lang || "he";
  const body = req.validated?.body || req.body;

  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");

  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  ensureEditableStatus(order);

  const { mode, areaId, pickupPointId, address } = body;

  // Compute payable subtotal for validation
  const subtotalMinor = order.pricing?.subtotal ?? 0;
  const discountMinor = order.pricing?.discountTotal ?? 0;
  const payableSubtotalMinor = Math.max(0, subtotalMinor - discountMinor);

  // Validate the shipping mode selection
  const validation = await validateShippingMode({
    mode,
    areaId,
    pickupPointId,
    payableSubtotalMinor,
    lang,
  });

  if (!validation.valid) {
    throw httpError(400, validation.error.code, validation.error.message, validation.error);
  }

  // Build the shipping mode snapshot
  const shippingModeSnapshot = {
    mode,
    computedPriceMinor: validation.shippingPriceMinor,
  };

  if (mode === SHIPPING_MODES.DELIVERY) {
    // Get area details for snapshot
    const area = await DeliveryArea.findById(areaId).lean();
    shippingModeSnapshot.areaId = area._id;
    shippingModeSnapshot.areaCodeSnapshot = area.code;
    shippingModeSnapshot.areaNameSnapshot = lang === "ar" ? area.nameAr : area.nameHe;

    // Set shipping address
    order.shippingAddress = {
      fullName: address.fullName,
      phone: address.phone,
      city: address.city,
      street: address.street,
      building: address.building || "",
      apartment: address.apartment || "",
      zip: address.zip || "",
      notes: address.notes || "",
    };
  } else if (mode === SHIPPING_MODES.PICKUP_POINT) {
    // Get area and pickup point details for snapshot
    const area = await DeliveryArea.findById(areaId).lean();
    const pickupPoint = await PickupPoint.findById(pickupPointId).lean();

    shippingModeSnapshot.areaId = area._id;
    shippingModeSnapshot.areaCodeSnapshot = area.code;
    shippingModeSnapshot.areaNameSnapshot = lang === "ar" ? area.nameAr : area.nameHe;
    shippingModeSnapshot.pickupPointId = pickupPoint._id;
    shippingModeSnapshot.pickupPointNameSnapshot = lang === "ar" ? pickupPoint.nameAr : pickupPoint.nameHe;
    shippingModeSnapshot.pickupPointAddressSnapshot = lang === "ar" ? pickupPoint.addressAr : pickupPoint.addressHe;

    // Clear shipping address for pickup
    order.shippingAddress = null;
  } else if (mode === SHIPPING_MODES.STORE_PICKUP) {
    // Get store config for snapshot
    const storeConfig = await StorePickupConfig.findOne({ configKey: "main" }).lean();
    shippingModeSnapshot.storeNameSnapshot = lang === "ar" ? storeConfig.nameAr : storeConfig.nameHe;
    shippingModeSnapshot.storeAddressSnapshot = lang === "ar" ? storeConfig.addressAr : storeConfig.addressHe;

    // Clear shipping address for store pickup
    order.shippingAddress = null;
  }

  // Update order with shipping mode snapshot
  order.shippingModeSnapshot = shippingModeSnapshot;

  // Update pricing.shipping with computed price
  order.pricing.shipping = validation.shippingPriceMinor;

  // Clear legacy shipping method if using new system
  order.shippingMethod = null;

  await order.save();

  // Reprice order to ensure totals are correct
  await repriceOrder(order._id);

  // Get fresh quote with updated data
  const quote = await quoteOrder({ orderId, userId, lang });

  res.json({
    ok: true,
    data: {
      order: order.toObject(),
      preview: quote.preview,
    },
  });
}

/**
 * GET /orders/:id/shipping-modes
 * Get available shipping modes and areas for checkout
 */
export async function getOrderShippingModes(req, res) {
  const { id: orderId } = req.params;
  const userId = req.user?.id;
  const lang = req.lang || "he";

  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");

  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  // Get quote which includes all shipping mode data
  const quote = await quoteOrder({ orderId, userId, lang });

  res.json({
    ok: true,
    data: {
      shippingModes: quote.preview.shippingModes,
      areas: quote.preview.areas,
      storePickup: quote.preview.storePickup,
      selectedMode: order.shippingModeSnapshot?.mode || null,
      selectedAreaId: order.shippingModeSnapshot?.areaId
        ? String(order.shippingModeSnapshot.areaId)
        : null,
      selectedPickupPointId: order.shippingModeSnapshot?.pickupPointId
        ? String(order.shippingModeSnapshot.pickupPointId)
        : null,
    },
  });
}

/**
 * GET /orders/:id/shipping-modes/pickup-points
 * Get pickup points for a specific area
 */
export async function getOrderPickupPoints(req, res) {
  const { id: orderId } = req.params;
  const userId = req.user?.id;
  const lang = req.lang || "he";
  const areaId = req.query?.areaId;

  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");
  if (!areaId) throw httpError(400, "AREA_ID_REQUIRED", "areaId query parameter is required");

  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  // Verify area exists and is active
  const area = await DeliveryArea.findById(areaId).lean();
  if (!area || !area.isActive) {
    throw httpError(400, "INVALID_AREA", "Invalid or inactive delivery area");
  }
  if (!area.pickupPointsEnabled) {
    throw httpError(400, "PICKUP_POINTS_DISABLED", "Pickup points are disabled for this area");
  }

  const pickupPoints = await PickupPoint.find({ areaId, isActive: true })
    .sort({ sort: 1, createdAt: -1 })
    .lean();

  res.json({
    ok: true,
    data: {
      areaId: String(area._id),
      areaName: lang === "ar" ? area.nameAr : area.nameHe,
      pickupPoints: pickupPoints.map((p) => ({
        id: String(p._id),
        name: lang === "ar" ? p.nameAr : p.nameHe,
        address: lang === "ar" ? p.addressAr : p.addressHe,
        notes: lang === "ar" ? p.notesAr : p.notesHe,
        hours: lang === "ar" ? p.hoursAr : p.hoursHe,
        feeMinor: p.feeMinor,
        phone: p.phone,
        coordinates: p.coordinates,
      })),
    },
  });
}
